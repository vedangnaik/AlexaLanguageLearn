'use strict';
// AWS SDK for using other AWS services.
const AWS = require('aws-sdk');
// Alexa SDK for using the Alexa service. 
const Alexa = require('alexa-sdk');
// A dictionary to make sure that only english words are accepted.
const wordlist = require('wordlist-english');
// Unique Identifier generator for primary key in DynamoDB.
const uuidv4 = require('uuid/v4');

// Names of supported languages which for some reason are not in the dictionary.
const supportedLangs = ["chinese", "french", "german", "italian", "portuguese", "russian", "spanish", "turkish"];
// Short-names of the languages for Translate and Polly.
const langShortForms = {
	"chinese": "zh",
	"french": "fr",
	"german": "de",
	"italian": "it",
	"portuguese": "pt",
	"russian": "ru",
	"spanish": "es",
	"turkish": "tr"
};
// Voice names for Polly.
const langPollyVoices = {
	"zh": "Zhiyu",
	"fr": "Mathieu",
	"de": "Hans",
	"it": "Giorgio",
	"pt": "Ricardo",
	"ru": "Maxim",
	"es": "Enrique",
	"tr": "Filiz"
};
// JSON list of facts for each supported languages.
const langFacts = require("./language_facts.json");

/*
This function makes sure that all the words in a sentence are valid english ones. 
*/
function validateSentence(sentence) {
	// Use Regex to remove all punctuation.
	var words = sentence.replace(/[^\w\s]|_/g, "").replace(/\s+/g, " ").toLowerCase().split(" ");
	for (var word in words) {
		// Make sure that word is not present in both the dictionary and the language list.
		if (!wordlist["english"].includes(words[word]) && !supportedLangs.includes(words[word])) {
			return false;
		}
	}
	return true;
}

const handlers = {
	/*
	Handles the LaunchIntent and starts a session.
	*/
	'LaunchRequest': function () {
		this.emit(":ask", "Welcome to Language Learning with Alexa.");
	},

	/*
	Handles the Translate Intent. Steps:
	1. Gets the target language and phrase from the user.
	2. Sends the phrase with language to Translate.
	3. Sends the phrase, translatation and language to DynamoDB for the QuizIntent.
	4. Sends the translated phrase and language to Polly for text-to-speech.
	5. Save the speech file to S3 temporarily.
	6. Speak out the speech file from S3.
	*/
	'TranslateIntent': function () {
		// Make sure that the sentence contains only English words.
		var sentence = this.event.request.intent.slots.sentence.value;
		if (!validateSentence(sentence)) {
			this.emit(":tell", "Your sentence contains some words not found in international English.");
		}

		// Ensure that the language is in the list of allowed languages.
		var language = this.event.request.intent.slots.language.value;
		language = language.toLowerCase();
		if (!validateSentence(language)) {
			this.emit(":tell", "This language is invalid.");
		} else if (language == "english") {
			this.emit(":tell", "Translating from English to English is not necessary.");
		} else if (langShortForms[language] == undefined) {
			this.emit(":tell", "This language is not supported by this skill.");
		}

		// 1. Send async call to Translate API.
		new Promise((resolve, reject) => {
			new AWS.Translate().translateText({
				"SourceLanguageCode": "en",
				"TargetLanguageCode": langShortForms[language],
				"Text": sentence
			}, (err, translatedText) => {
				if (err) { reject(err); }
				else { resolve(translatedText); }
			});
		// 2. If Translate succeeds, send translated text to QuizTable to quiz the user on later.
		}).then(translatedText => {
			return new Promise((resolve, reject) => {
				new AWS.DynamoDB().putItem({
					TableName: "AlexaLanguageLearn-QuizTable",
					Item: {
						"allqt_sentence_id": {"S": uuidv4() },
						"allqt_language": {"S": language},
						"allqt_sentence": {"S": sentence},
						"allqt_translation": {"S": translatedText["TranslatedText"] },
						"allqt_user": {"S": this.event.session.user.userId}
					}
				}, function(err, data) {
					if (err) { reject(err); }
					else { resolve(translatedText); }
				});
			});
		// 3. If DynamoDB succeeds, send the same translated text to Polly to speak.
		}).then(translatedText => {
			return new Promise((resolve, reject) => {
				new AWS.Polly({
					signatureVersion: 'v4',
					region: 'us-east-1'
				}).synthesizeSpeech({
					"Text": translatedText["TranslatedText"],
					"OutputFormat": "mp3",
					"VoiceId": langPollyVoices[translatedText["TargetLanguageCode"]]
				}, (err, translatedSpeech) => {
					if (err) { reject(err); }
					else { resolve(translatedSpeech); }
				});
			});
		// 4. If Polly succeeds, save AudioStream to S3 Bucket.
		}).then(translatedSpeech => {
			return new Promise((resolve, reject) => {
				if (translatedSpeech.AudioStream instanceof Buffer) {
					new AWS.S3().upload({
						"Bucket": "alexalanguagelearn-bucket",
						"Key": "temp.mp3",
						"Body": translatedSpeech.AudioStream
					}, (err, savedFileInfo) => {
						if (err) { reject(err); }
						else { resolve(savedFileInfo); }
					});
				} else { reject(err); }
			});
		// 5. If S3 filesave succeeds, play audio back to user with SSML.
		}).then(savedFileInfo => {
			this.emit(":tell", "The phrase " + sentence + " in " + language + " is: <audio src='" + savedFileInfo["Location"] + "'/>");
		// An error in any of the above steps is logged here.
		}).catch((err) => {
			console.log(err);
			this.emit(":tell", "There was a translation error.");
		});
	},

	/*
	Handles the QuizIntent. Steps:
	1. Get the language the user wishes to be tested in.
	2. Get all DynamoDB rows in that language back and pick a random one.
	3. Send the phrase to Polly for speaking out.
	4. Save the speech file to S3 temporarily.
	5. Play the file and ask the user what it means.
	6. Wait for the response and compare with appropriate output.
	 */
	'QuizIntent': function() {
		if (!this.event.request.intent.slots.answer.value) {
			var language = this.event.request.intent.slots.language.value;
			language = language.toLowerCase();
			if (!validateSentence(language)) {
				this.emit(":tell", "This language is invalid.");
			} else if (language == "english") {
				this.emit(":tell", "Quizzing you on English is not necessary.");
			} else if (langShortForms[language] == undefined) {
				this.emit(":tell", "This language is not supported by this skill.");
			}

			// Get all rows regarding the user's language from DynamoDB.
			new Promise((resolve, reject) => {
				new AWS.DynamoDB().scan({
					TableName: "AlexaLanguageLearn-QuizTable",
					FilterExpression: "allqt_language = :l and allqt_user = :u",
					ExpressionAttributeValues: {
						":l": {"S" : language },
						":u": {"S": this.event.session.user.userId }
					},
					ReturnConsumedCapacity: "TOTAL"
				}, function(err, results) {
					if (err) { reject(err); }
					// Pick a random one using some maths.
					else { resolve(results["Items"][Math.floor(Math.random() * results["Count"])]); }
				});
			}).then(randomItem => {
				this.attributes.randomItem = randomItem;
				return new Promise((resolve, reject) => {
					new AWS.Polly({
						signatureVersion: "v4",
						region: "us-east-1"
					}).synthesizeSpeech({
						"Text": randomItem["allqt_translation"]["S"],
						"OutputFormat": "mp3",
						"VoiceId": langPollyVoices[langShortForms[randomItem["allqt_language"]["S"].toLowerCase()]]
					}, (err, translatedSpeech) => {
						if (err) { reject(err); }
						else { resolve(translatedSpeech); }
					});
				});
			}).then(translatedSpeech => {
				return new Promise((resolve, reject) => {
					if (translatedSpeech.AudioStream instanceof Buffer) {
						new AWS.S3().upload({
							"Bucket": "alexalanguagelearn-bucket",
							"Key": "temp.mp3",
							"Body": translatedSpeech.AudioStream
						}, (err, savedFileInfo) => {
							if (err) { reject(err); }
							else { resolve(savedFileInfo); }
						});
					} else { reject(err); }
				});
			}).then(savedFileInfo => {
				this.emit(":elicitSlot", "answer", "What is <audio src='" + savedFileInfo["Location"] + "'/>, in " + language + ", mean?");
			});
		} else {
			// Once the user has responded, compare with the correct answer and reply appropriately.
			if (this.event.request.intent.slots.answer.value == this.attributes.randomItem["allqt_sentence"]["S"]) {
				this.emit(":tell", "Your answer is correct!");
			} else {
				this.emit(":tell", "Your answer is wrong");
			}
		}
	},

	/*
	Handles the FactIntent. Steps:
	1. Pick a random fact from the array connected to the user's language from language_facts.json.
	2. Speak out the fact.
	*/
	'FactIntent': function() {
		var language = this.event.request.intent.slots.language.value;
		language = language.toLowerCase();
		if (language == "english") {
			this.emit(":tell", "Quizzing you on English is not necessary.");
		} else if (langShortForms[language] == undefined) {
			this.emit(":tell", "This language is not supported by this skill.");
		}

		var factBank = langFacts[language];
		this.emit(":tell", factBank[Math.floor(Math.random() * factBank.length)]);
	},


	'AMAZON.HelpIntent': function () {},
	'AMAZON.CancelIntent': function () {},
	'AMAZON.StopIntent': function () {}
};

exports.handler = function (event, context, callback) {
	const alexa = Alexa.handler(event, context, callback);
	alexa.APP_ID = "amzn1.ask.skill.811fe377-3634-414a-bbb0-c70ff4c86125";
	alexa.registerHandlers(handlers);
	alexa.execute();
};

/*
List of TODOs
1. Get a better dictionary.
2. Handle all built-in intents.
3. Error handling for the database, all slots, etc.
4. Utterances for TranslateIntent
5. Change the name of the skill.
6. Fix bug in QuizIntent.
*/