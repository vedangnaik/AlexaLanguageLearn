'use strict';
const AWS = require('aws-sdk');
const Alexa = require('alexa-sdk');
const wordlist = require('wordlist-english');
const uuidv4 = require('uuid/v4');

const supportedLangs = ["chinese", "french", "german", "italian", "japanese", "portuguese", "russian", "spanish", "turkish"];
const langShortForms = {
	"chinese": "zh",
	"french": "fr",
	"german": "de",
	"italian": "it",
	"japanese": "jp",
	"portuguese": "pt",
	"russian": "ru",
	"spanish": "es",
	"turkish": "tr"
};

const langPollyVoices = {
	"zh": "Zhiyu",
	"fr": "Mathieu",
	"de": "Hans",
	"it": "Giorgio",
	"jp": "Takumi",
	"pt": "Ricardo",
	"ru": "Maxim",
	"es": "Enrique",
	"tr": "Filiz"
};

function validateSentence(sentence) {
	var words = sentence.replace(/[^\w\s]|_/g, "").replace(/\s+/g, " ").toLowerCase().split(" ");
	for (var word in words) {
		if (!wordlist["english"].includes(words[word]) && !supportedLangs.includes(words[word])) {
			return false;
		}
	}
	return true;
}

const handlers = {
	'LaunchRequest': function () {
		this.emit(":ask", "Welcome to Language Learning with Alexa.");
	},


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
			this.emit(":tell", "<audio src='" + savedFileInfo["Location"] + "'/>");
		// An error in any of the above steps is logged here.
		}).catch((err) => {
			console.log(err);
			this.emit(":tell", "There was a translation error.");
		});
	},


	'QuizIntent': function() {
		// Ensure that the language is valid.
		var language = this.event.request.intent.slots.language.value;
		language = language.toLowerCase();
		if (!validateSentence(language)) {
			this.emit(":tell", "This language is invalid.");
		} else if (language == "english") {
			this.emit(":tell", "Quizzing you on English is not necessary.");
		} else if (langShortForms[language] == undefined) {
			this.emit(":tell", "This language is not supported by this skill.");
		}

		// Get 
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
				else { resolve(results["Items"][Math.floor(Math.random() * results["Count"])]); }
			});
		}).then(randomItem => {
			if (!this.event.request.intent.slots.answer.value) {
				new Promise((resolve, reject) => {
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
				if (this.event.request.intent.slots.answer.value == randomItem["allqt_sentence"]["S"]) {
					this.emit(":tell", "Your answer was correct.");
				} else {
					this.emit(":tell", "Your answer was wrong.");
				}
			}
		});
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