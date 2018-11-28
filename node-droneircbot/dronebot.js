var irc = require('irc');
var fs = require('fs');
var https = require('https');
var xml2js = require('xml2js');

var fs = require('fs');
var config = JSON.parse(fs.readFileSync('config.json', 'utf8'));

var hopmPattern = /^(?:(CHECK) -> )?OPEN PROXY(?: -> [^ ]+)? ([0-9a-fA-F.:]+):([0-9]{2,5}) \(([^)]+)\) \[([^\]]+)\]$/;

function timeConverter(UNIX_timestamp){
	var a = new Date(UNIX_timestamp * 1000);
	var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
	var year = a.getFullYear();
	var month = months[a.getMonth()];
	var date = a.getDate();
	var hour = a.getHours();
	var min = a.getMinutes();
	var sec = a.getSeconds();
	var time = date + ' ' + (month<10?'0':'') + month + ' ' + year + ' ' + hour + ':' + (min<10?'0':'') + min + ':' + (sec<10?'0':'') + sec ;
	return time;
}

var listeners = {
	'registered': [
		function handler(message){
			bot.send("OPER", config.operLogin, config.operPassword);
			bot.send("MODE", bot.nick, "+B");
			bot.send("JOIN", "0");
			bot.join(config.channel, function(message){});
		}
	],
	'ctcp-version': [
		function handler(from, to, message){
			bot.ctcp(from, "notice", "VERSION PIRCbot/nodejs/irc (k4be) v0.02");
		}
	],
	'error': [
		function handler(message){
			console.log('error: ', message);
		}
	],
	'message': [
		function handler(nick, to, text, message){
			if(to != config.channel) return; // only channel messages
			if(config.hopmNicks.indexOf(nick) !== -1){
				var match = hopmPattern.exec(text);
				if(match){
					switch(match[4]){
						case 'HTTP': case 'HTTPPOST': case 'HTTPS': case 'HTTPSPOST': var type = 9; break;
						case 'SOCKS4': case 'SOCKS5': var type = 8; break;
						case 'WINGATE': var type = 14; break;
						case 'ROUTER': case 'DREAMBOX': var type = 15; break;
						case 'SSH': return; // emerson@Freenode suggested ignoring these results because it only checks the sshd banner
						default: var type = 6; bot.say(config.channel, "DRONEBL: type "+match[4]+" is unknown to me! Reporting as 6"); break;
					}
					dronebl.report(match[2], type, false, match[3]);
					//bot.say(config.channel, "DRONEBL: reported ip "+match[2]);
				}
			} else if(config.operNicks.indexOf(nick) !== -1 && text.indexOf(bot.nick) == 0){
				var commandstr = text.substr(text.indexOf(' ')+1);
				if(!commandstr) return;
				command = commandstr.split(' ');
				switch(command[0]){
					default: case "help": bot.notice(nick, "Available commands: 'help', 'listtypes', 'report [ip] [type] [comment] [port]' (comment or port=false for none; use _ as space in commend), 'check [ip]', 'remove [id]' (id obtained with check), 'rehash'"); break;
					case "listtypes":
						if(!dronebl.types){
							bot.notice(nick, "Type data not available");
							break;
						}
						for(var i=0; i < dronebl.types.length; i++){
							bot.notice(nick, "Type "+dronebl.types[i].type+": "+dronebl.types[i].name);
						}
						break;
					case "check":
						if(command.length != 2){
							bot.notice(nick, "Usage: check [ip]");
							break;
						}
						dronebl.check(command[1]);
						break;
					case "report":
						if(command.length < 3 || command.length > 5){
							bot.notice(nick, "Usage: report [ip] [type] [comment] [port]' (comment or port=false for none)");
							break;
						}
						switch(command.length){
							case 3: dronebl.report(command[1], command[2]); break;
							case 4: dronebl.report(command[1], command[2], command[3].replace(/_/g, ' ')); break;
							case 5: dronebl.report(command[1], command[2], command[3].replace(/_/g, ' '), command[4]); break;
						}
						break;
					case "remove":
						if(command.length != 2){
							bot.notice(nick, "Usage: remove [id]");
							break;
						}
						dronebl.remove(command[1]);
						break;
					case "rehash": config = JSON.parse(fs.readFileSync('config.json', 'utf8')); break;
				}
			}
		}
	]
};

var dronebl = {
	'types': false,
	'getTypes': function(){
		var xml = '<typelist />';
		dronebl.access(xml, function(err, result){
			if(result.response.typelist === undefined){
				console.log('WARNING: empty typelist!'); // why would they send an empty list?
			} else {
				dronebl.types = [];
				for(var i=0; i<result.response.typelist.length; i++){
					dronebl.types.push({ "name": result.response.typelist[i].$.description, "type": result.response.typelist[i].$.type });
				}
			}
		});
	},
	'getTypeName': function(type){
		if(dronebl.types == false){
			dronebl.getTypes(); // shouldn't happen
			return type;
		}
		for(var i=0; i<dronebl.types.length; i++){
			if(dronebl.types[i].type == type) return dronebl.types[i].name;
		}
		return type;
	},
	'report': function(ip, type, comment=false, port=false){
		var post_data = '<add ip="'+ip+'" type="'+type+'"';
		if(comment){
			post_data += ' comment="'+comment+'"';
		}
		if(port){
			post_data += ' port="'+port+'"';
		}
		post_data += ' />';
		dronebl.access(post_data, function(err, result){
			try {
				if(err) throw err;
				if(result.response.warning !== undefined){
					for(var i=0; i<result.response.warning.length; i++){
						bot.say(config.channel, 'IP ' + result.response.warning[i].$.ip + ': WARNING: ' + result.response.warning[i].$.data);
					}
				}
				if(result.response.success !== undefined){
					for(var i=0; i<result.response.success.length; i++){
						bot.say(config.channel, 'IP ' + result.response.success[i].$.ip + ': SUCCESS: ' + result.response.success[i].$.data);
					}
				}
			} catch(e){
				console.log("Report exception: ", e);
			}
		});
	},
	'remove': function(id){
		var post_data = '<remove id="' + id + '" />';
		dronebl.access(post_data, function(err, result){
			try {
				if(err) throw err;
				if(result.response.warning !== undefined){
					for(var i=0; i<result.response.warning.length; i++){
						bot.say(config.channel, 'id ' + result.response.warning[i].$.id + ': WARNING: ' + result.response.warning[i].$.data);
					}
				}
				if(result.response.success !== undefined){
					for(var i=0; i<result.response.success.length; i++){
						bot.say(config.channel, 'id ' + result.response.success[i].$.id + ': SUCCESS: ' + result.response.success[i].$.data);
					}
				}
			} catch(e){
				console.log("Remove exception: ", e);
			}
		});
	},
	'check': function(ip){
		var post_data = '<lookup ip="' + ip + '" />';
		dronebl.access(post_data, function(err, result){
			try {
				if(err) throw err;
				if(result.response.result === undefined){
					bot.say(config.channel, "No entries");
				} else {
					for(var i=0; i<result.response.result.length; i++){
						var date = timeConverter(result.response.result[i].$.timestamp);
						bot.say(config.channel, result.response.result[i].$.ip + ': LOOKUP: type="' + dronebl.getTypeName(result.response.result[i].$.type) + '", listing ' + (result.response.result[i].$.listed==0?'not ':'') + 'active, added on ' + date + ', id=' + result.response.result[i].$.id + ', comments: "' + result.response.result[i].$.comment+'"');
					}
				}
			} catch(e){
				console.log("Check exception: ", e);
			}
		});
	},
	'access': function(xml, callback=false){
		if(callback == false){
			callback = function(){};
		}
		var post_data = '<?xml version="1.0"?><request key="'+config.dronebl.rpckey+'"';
		if(config.dronebl.staging){
			post_data += ' staging="1"';
		}
		post_data += '>';
		
		post_data += xml; // just assume that the caller did not create malformed xml
		
		post_data += '</request>';
		var options = {
			host: config.dronebl.host,
			port: 443,
			path: config.dronebl.path,
			method: 'POST',
			headers: {
				'Content-Type': 'text/xml'
			}
		};
		var request = https.request(options, function(res){
			res.on('data', function(chunk){
				var text = chunk.toString('utf8');
				xml2js.parseString(text, callback);
			});
		});
		console.log('post_data: ', post_data);
		request.write(post_data);
		request.end();
	}
};

dronebl.getTypes();
var bot = new irc.Client(config.server, config.nick, config.options);

for(var key in listeners){
	var functions = listeners[key];
	for(var i=0; i<functions.length; i++){
		bot.addListener(key, functions[i]);
	}
}

/*
message = {
    prefix: "The prefix for the message (optional)",
    nick: "The nickname portion of the prefix (optional)",
    user: "The username portion of the prefix (optional)",
    host: "The hostname portion of the prefix (optional)",
    server: "The servername (if the prefix was a servername)",
    rawCommand: "The command exactly as sent from the server",
    command: "Human readable version of the command",
    commandType: "normal, error, or reply",
    args: ['arguments', 'to', 'the', 'command'],
}
*/
