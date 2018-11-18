'use strict';
const AWS = require('aws-sdk');
const Alexa = require('alexa-sdk');
const wordlist = require('wordlist-english');
const uuidv4 = require('uuid/v4');

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

function validatePhrase(phrase) {
    var words = phrase.replace(/[^\w\s]|_/g, "").replace(/\s+/g, " ").toLowerCase().split(" ");        
    for (var word in words) {
        if (!wordlist["english"].includes(words[word])) {
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
		var phrase = this.event.request.intent.slots.phrase.value;
		if (!validatePhrase(phrase)) {
			this.emit(":tell", "Your sentence contains some words not found in international English.");
		}

		var language = this.event.request.intent.slots.language.value;
		language = language.toLowerCase();
		if (!validatePhrase(language)) {
			this.emit(":tell", "This language is invalid.");
		} else if (language == "english") {
			this.emit(":tell", "Translating from English to English is not necessary.");
		} else if (langShortForms[language] == undefined) {
			this.emit(":tell", "This language is not supported by this skill.");
		}

		var userID = this.event.session.user.userId;
		var _ = new AWS.DynamoDB();
		_.putItem({
			TableName: "AlexaLanguageLearn-QuizTable",
			Item: {
				"phrase_id": {"S": uuidv4()},
				"phrase": {"S": phrase},
				"language": {"S": language},
				"user": {"S": userID}
			}
		}, function(err, data) {
			if (err) { console.log(err); }
			else { console.log(data); }
		});

		new Promise((resolve, reject) => {
			var _ = new AWS.Translate();
			_.translateText({
				"SourceLanguageCode": "en",
				"TargetLanguageCode": langShortForms[language],
				"Text": phrase
			}, (err, translatedText) => {
				if (err) { reject(err); }
				else { resolve(translatedText); }
			});
		}).then(translatedText => {
			return new Promise((resolve, reject) => {
				var _ = new AWS.Polly({
					signatureVersion: 'v4',
					region: 'us-east-1'
				});
				_.synthesizeSpeech({
					"Text": translatedText["TranslatedText"],
					"OutputFormat": "mp3",
					"VoiceId": langPollyVoices[translatedText["TargetLanguageCode"]]
				}, (err, translatedSpeech) => {
					if (err) { reject(err); }
					else { resolve(translatedSpeech); }
				});
			});
		}).then(translatedSpeech => {
			return new Promise((resolve, reject) => {
				if (translatedSpeech.AudioStream instanceof Buffer) {
					var _ = new AWS.S3();
					_.upload({
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
			this.emit(":tell", "<audio src='" + savedFileInfo["Location"] + "'/>");
		}).catch((err) => {
			console.log(err);
			this.emit(":tell", "There was a translation error.");
		});
	},
	'QuizIntent': function() {
		var language = this.event.request.intent.slots.language.value;
		language = language.toLowerCase();

		
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