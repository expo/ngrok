var request = require('request');
var spawn = require('child_process').spawn;
var Emitter = require('events').EventEmitter;
var platform = require('os').platform();
var lock = require('lock')();
var async = require('async');
var uuid = require('uuid');
var url = require('url');
var logfmt = require('logfmt');
var bin = require('@expo/ngrok-bin');

var noop = function() {};
var emitter = new Emitter().on('error', noop);
var ngrok, api, tunnels = {};

function connect(opts, cb) {

	if (typeof opts === 'function') {
		cb = opts;
	}

	cb = cb || noop;
	opts = defaults(opts);

	if (api) {
		return runTunnel(opts, cb);
	}

	lock('ngrok', function(release) {
		function run(err) {
			if (err) {
				emitter.emit('error', err);
				return cb(err);
			}
			runNgrok(opts, release(function(err) {
				if (err) {
					emitter.emit('error', err);
					return cb(err);
				}
				runTunnel(opts, cb)
			}));
		}

		opts.authtoken ?
			authtoken(opts.authtoken, opts.configPath, run) :
			run(null);
	});
}

function defaults(opts) {
	opts = opts || {proto: 'http', addr: 80};

	if (typeof opts === 'function') {
		opts = {proto: 'http', addr: 80};
	}

	if (typeof opts !== 'object') {
		opts = {proto: 'http', addr: opts};
	}

	if (!opts.proto) {
		opts.proto = 'http';
	}

	if (!opts.addr) {
		opts.addr = opts.port || opts.host || 80;
	}

	if (opts.httpauth) {
		opts.auth = opts.httpauth;
	}

	if (['us', 'eu', 'au', 'ap'].indexOf(opts.region) === -1) {
		opts.region = 'us';
	}

	if (!opts.configPath) {
		opts.configPath = '~/.ngrok2/ngrok.yml';
	}

	return opts;
}

function runNgrok(opts, cb) {
	if (api) {
		return cb();
	}

	emitter.emit('statuschange', 'starting');

	ngrok = spawn(
		bin,
		['start', '--none', '--log=stdout', '--region=' + opts.region, '-config=' + opts.configPath]
	);

	ngrok.stdout.on('data', function (chunk) {
		var lines = chunk.toString().split(/\r?\n/);
		lines.forEach(function (line) {
			if (!line) return;
			var data = logfmt.parse(line);
			if (data.obj === 'web' && data.msg === 'starting web service' && data.addr) {
				api = request.defaults({
					baseUrl: 'http://' + data.addr,
					json: true
				});
				cb();
			} else if (data.obj === 'csess' && data.msg === 'session closed, starting reconnect loop') {
				emitter.emit('statuschange', 'reconnecting');
			} else if (data.obj === 'csess' && data.msg === 'client session established') {
				emitter.emit('statuschange', 'online');
			}
		});
	});

	ngrok.stderr.on('data', function (data) {
		var info = data.toString().substring(0, 10000);
		return cb(new Error(info));
	});

	ngrok.on('exit', function () {
		ngrok = null;
		api = null;
		tunnels = {};
	});

	ngrok.on('close', function () {
		return emitter.emit('close');
	});

	process.on('exit', function() {
		kill();
	});

	ngrok.on('error', function(err) {
		cb(err);
	});
}

function runTunnel(opts, cb) {
	_runTunnel(opts, function(err, publicUrl, uiUrl) {
		if (err) {
			emitter.emit('error', err);
			return cb(err);
		}
		emitter.emit('connect', publicUrl, uiUrl);
		return cb(null, publicUrl, uiUrl);
	});
}

function _runTunnel(opts, cb) {
	var retries = 100;
	opts.name = String(opts.name || uuid.v4());
	var retry = function() {
		if (!api) {
			return;
		}
		api.post(
			{url: 'api/tunnels', json: opts},
			function(err, resp, body) {
				if (err) {
					return cb(err);
				}
                                var notReady = (resp.statusCode === 500 && /panic/.test(body)) ||
					(resp.statusCode === 502 && body.details &&
						body.details.err === 'tunnel session not ready yet') ||
					(resp.statusCode === 503 && body.details &&
						body.details.err === 'a successful ngrok tunnel session has not yet been established');

				if (notReady) {
					return retries-- ?
						setTimeout(retry, 200) :
						cb(new Error(body));
				}
				var publicUrl = body && body.public_url;
				if (!publicUrl) {
					var err = Object.assign(new Error(body.msg || 'failed to start tunnel'), body);
					return cb(err);
				}
				tunnels[publicUrl] = body.uri;
				if (opts.proto === 'http' && opts.bind_tls !== false) {
					tunnels[publicUrl.replace('https', 'http')] = body.uri + ' (http)';
				}
				var uiUrl = url.parse(resp.request.uri);
				uiUrl = uiUrl.resolve('/').slice(0, -1);
				return cb(null, publicUrl, uiUrl);
			});
	};

	retry();
}

function authtoken(token, configPath, cb) {
	cb = cb || noop;
	var a = spawn(
		bin,
		['authtoken', token, '-config=' + configPath]
	);
	a.stdout.once('data', done.bind(null, null, token));
	a.stderr.once('data', done.bind(null, new Error('cant set authtoken')));
	a.on('error', function(err) {
	  cb(err);
	});

	function done(err, token) {
		cb(err, token);
		a.kill();
	}
}

function disconnect(publicUrl, cb) {
	cb = cb || noop;
	if (typeof publicUrl === 'function') {
		cb = publicUrl;
		publicUrl = null;
	}
	if (!api) {
		return cb();
	}
	if (publicUrl) {
		return api.del(
			tunnels[publicUrl],
			function(err, resp, body) {
				if (err || resp.statusCode !== 204) {
					return cb(err || new Error(body));
				}
				delete tunnels[publicUrl];
				emitter.emit('disconnect', publicUrl);
				return cb();
			});
	}

	return async.each(
		Object.keys(tunnels),
		disconnect,
		function(err) {
			if (err) {
				emitter.emit('error', err);
				return cb(err);
			}
			emitter.emit('disconnect');
			return cb();
		});
}

function kill(cb) {
	cb = cb || noop;
	if (!ngrok) {
		return cb();
	}
	ngrok.on('exit', function() {
		emitter.emit('disconnect');
		return cb();
	});
	return ngrok.kill();
}

function ngrokProcess() {
	return ngrok;
}

emitter.connect = connect;
emitter.disconnect = disconnect;
emitter.authtoken = authtoken;
emitter.kill = kill;
emitter.process = ngrokProcess;

module.exports = emitter;
