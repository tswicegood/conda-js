// Set up module to run in browser and in Node.js
// Based loosely on https://github.com/umdjs/umd/blob/master/nodeAdapter.js
if ((typeof module === 'object' && typeof define !== 'function') || (window && window.atomRequire)) {
    // We are in Node.js or atom

    if (typeof window !== "undefined" && window.atomRequire) {
        var require = window.atomRequire;
    }

    var ChildProcess = require('child_process');
    var Promise = require('promise');

    // FIXME: I don't think `method` should get passed in here -- the web-based one
    //        should be smart enough to know what type of command is being invoked
    // FIXME: Is `url` or `data` needed here?
    var api = function(cmdList, method, url, data) {
        return new Promise(function(fulfill, reject) {
            var params = cmdList.concat(['--json']);
            var conda = ChildProcess.spawn('conda', params, {});
            var buffer = [];
            conda.stdout.on('data', function(data) {
                // FIXME: You can call setEncoding on `stdout` to keep from having
                //        to call `toString` all the time.
                buffer.push(data.toString());
            });
            conda.on('close', function() {
                try {
                    fulfill(JSON.parse(buffer.join('')));
                }
                catch(ex) {
                    reject({
                        'exception': ex,
                        'result': buffer.join('')
                    });
                }
            });
        });
    };

    // Returns Promise like api(), but this object has additional callbacks
    // for progress bars. Retrieves data via ChildProcess.
    var progressApi = function(cmdList, url, data) {
        var callbacks = [];
        var progressing = true;
        var params = cmdList.concat(['--json']);
        var conda = ChildProcess.spawn('conda', params, {});
        var buffer = [];
        var promise = new Promise(function(fulfill, reject) {
            conda.stdout.on('data', function(data) {
                var rest = data.toString();
                if (rest.indexOf('\0') == -1) {
                    progressing = false;
                }

                if (!progressing) {
                    buffer.push(data);
                    return;
                }
                while (rest.indexOf('\0') > -1 && progressing) {
                    var dataEnd = rest.indexOf('\0');
                    var first = rest.slice(0, dataEnd);
                    rest = rest.slice(dataEnd + 1);
                    buffer.push(first);
                    var json = JSON.parse(buffer.join(''));
                    buffer = [];
                    promise.progress(json);

                    if (json.finished === true) {
                        progressing = false;
                    }
                }
            });
            conda.on('close', function() {
                try {
                    fulfill(JSON.parse(buffer.join('')));
                }
                catch(ex) {
                    reject({
                        'exception': ex,
                        'result': buffer.join('')
                    });
                }
            });
        });
        promise.onProgress = function(f) {
            callbacks.push(f);
        };
        promise.progress = function(data) {
            // FIXME? Using `callbacks.forEach` would read a little cleaner
            for (var i = 0; i < callbacks.length; i++) {
                callbacks[i](data);
            }
        };
        return promise;
    };

    // FIXME: Let's pull this into a separate file so its separate for testing
    if (process.argv.length == 3 && process.argv[2] == '--server') {
        var express = require('express');
        var bodyParser = require('body-parser');
        var app = express();
        var http = require('http').Server(app);
        var io = require('socket.io')(http);

        process.argv = [];
        console.log('running as server');

        app.use(bodyParser.urlencoded({ extended: false }));
        app.get('/', function(req, res) {
            res.sendfile(__dirname + '/test.html');
        });
        app.get('/conda.js', function(req, res) {
            res.sendfile(__dirname + '/conda.js');
        });
        app.get('/test.js', function(req, res) {
            res.sendfile(__dirname + '/test.js');
        });
        app.all('/api/*', function(req, res) {
            var parts = req.param('command');
            if (typeof parts === "undefined") {
                // POST request
                parts = req.param('command[]');
            }
            // FIXME: I got `Handling undefined` when I ran this in Firefox:
            //          conda.info().then(function(i) { console.log(i); })
            // FIXME: Looks like this was a docs issue -- needed conda.DEV_SERVER=true
            console.log('Handling', parts);
            api(parts).then(function(data) {
                res.send(JSON.stringify(data));
            });
        });

        io.on('connection', function(socket) {
            console.log('connected');
            socket.on('api', function(data) {
                var parts = data.data.command;

                var progress = progressApi(parts);
                progress.onProgress(function(progress) {
                    socket.emit('progress', progress);
                });
                progress.done(function(data) {
                    socket.emit('result', data);
                    socket.disconnect();
                });
            });
            socket.on('disconnect', function(data) {
                socket.disconnect();
            });
        });

        io.on('disconnect', function() {
            console.log('disconnected');
        });

        http.listen(8000);
    }

    module.exports = factory(api, progressApi);
}
else {
    // We are in the browser
    var parse = function(cmdList, url, data) {
        var parts = url;
        if (window.conda.DEV_SERVER) {
            return {
                path: '',
                data: {
                    command: cmdList
                }
            };
        }

        if (typeof data === "undefined") {
            data = {};
        }

        var path = parts.map(encodeURIComponent).join('/');
        return {
            data: data,
            path: path
        };
    };

    var api = function(cmdList, method, url, data) {
        var path = parse(cmdList, url, data);
        return Promise.resolve($.ajax({
            data: path.data,
            dataType: 'json',
            type: method,
            url: window.conda.API_ROOT + path.path
        }));
    };

    // Returns Promise like api(), but this object has additional callbacks
    // for progress bars. Retrieves data via websocket.
    var progressApi = function(cmdList, url, data) {
        var callbacks = [];
        var promise = new Promise(function(fulfill, reject) {
            var path = parse(cmdList, url, data);
            var socket = io();
            socket.emit('api', path);
            socket.on('progress', function(progress) {
                console.log(progress);
                promise.onProgress(progress);
            });
            socket.on('result', function(result) {
                console.log(result);
                socket.disconnect();
                fulfill(result);
            });
        });
        promise.onProgress = function(f) {
            callbacks.push(f);
        };
        promise.progress = function(data) {
            for (var i = 0; i < callbacks.length; i++) {
                callbacks[i](data);
            }
        };
        return promise;
    };

    window.conda = factory(api, progressApi);
}

function factory(api, progressApi) {
    var defaultOptions = function(options, defaults) {
        if (typeof options === "undefined" || options === null) {
            return defaults;
        }
        for (var key in defaults) {
            if (defaults.hasOwnProperty(key)) {
                if (!(key in options)) {
                    options[key] = defaults[key];
                }
            }
        }

        return options;
    };

    var nameOrPrefixOptions = function(name, options, defaults) {
        defaults.name = null;
        defaults.prefix = null;

        options = defaultOptions(options, defaults);
        if (!(options.name || options.prefix)) {
            throw new CondaError(name + ": either name or prefix required");
        }
        if (options.name && options.prefix) {
            throw new CondaError(name + ": exactly one of name or prefix allowed");
        }

        var data = {};
        var cmdList = [];
        if (options.name) {
            data.name = options.name;
            cmdList.push('--name');
            cmdList.push(options.name);
        }
        if (options.prefix) {
            data.prefix = options.prefix;
            cmdList.push('--prefix');
            cmdList.push(options.prefix);
        }

        return {
            options: options,
            data: data,
            cmdList: cmdList
        };
    };

    var makeFlags = function(options, flags) {
        // converts a name like useIndexCache to use-index-cache
        var _convert = function(f) {
            return f.replace(/([A-Z])/, function(a, b) { return "-" + b.toLocaleLowerCase(); });
        };

        var cmdList = [];
        for (var flag in flags) {
            if (flags.hasOwnProperty(flag)) {
                if (typeof options[flag] === "undefined") {
                    options[flag] = flags[flag];
                }

                if (options[flag]) {
                    cmdList.push('--' + _convert(flag));
                }
            }
        }

        return cmdList;
    };

    var CondaError = (function() {
        function CondaError(message) {
            this.message = message;
        }

        CondaError.prototype.toString = function() {
            return "CondaError: " + this.message;
        };

        return CondaError;
    })();

    var Env = (function() {
        function Env(name, prefix) {
            this.name = name;
            this.prefix = prefix;

            this.isDefault = false;
            this.isRoot = false;
        }

        Env.prototype.linked = function(options) {
            options = defaultOptions(options, { simple: false });

            var cmdList = ['list', '--prefix', this.prefix];
            var path = ['envs', this.name, 'linked'];
            return api(cmdList, 'get', path).then(function(fns) {
                if (options.simple) {
                    return fns;
                }
                var promises = [];
                for (var i = 0; i < fns.length; i++) {
                    promises.push(Package.load(fns[i]));
                }

                return Promise.all(promises).then(function(pkgs) {
                    return pkgs;
                });
            });
        };

        Env.prototype.revisions = function() {
            return api(['list', '--prefix', this.prefix, '--revisions'],
                       'get', ['envs', this.name, 'revisions']);
        };

        Env.prototype.install = function(pkg, options) {
            options = defaultOptions(options, { progress: false });
            var cmdList = ['install', '--prefix', this.prefix, pkg];
            var path = ['envs', this.name, 'install', pkg];
            var data = {};
            if (!options.progress) {
                cmdList.push('--quiet');
                data.quiet = true;

                return api(cmdList, 'post', path, data);
            }
            else {
                return progressApi(cmdList, path, data);
            }
        };

        Env.prototype.update = function(options) {
            options = defaultOptions(options, {
                packages: []
            });
            cmdList = makeFlags(options, {
                dryRun: false,
                unknown: false,
                noDeps: false,
                useIndexCache: false,
                useLocal: false,
                noPin: false,
                all: false
            });

            if (options.packages.length === 0 && !options.all) {
                throw new CondaError("Env.update: must specify packages to update or all");
            }

            var cmdList = ['update', '--prefix', this.prefix]
                .concat(cmdList)
                .concat(options.packages);

            return api(cmdList, 'post', ['envs', this.name, 'update'], options);
        };

        Env.prototype.remove = function(pkg) {
            return api(['remove', '--prefix', this.prefix, pkg],
                       'post', ['envs', this.name, 'install', pkg]);
        };

        Env.prototype.clone = function(options) {
            var result = nameOrPrefixOptions("Env.clone", options, {});
            options = result.options;

            var data = options.data;
            var cmdList = ['create', '--clone', this.prefix];
            cmdList = cmdList.concat(options.cmdList);

            return api(cmdList, 'post', ['env', this.prefix, 'clone'], data);
        };

        Env.prototype.removeEnv = function() {
            return progressApi(['remove', '--all', '--prefix', this.prefix],
                               ['envs', this.name, 'delete'], {});
        };

        Env.create = function(options) {
            var result = nameOrPrefixOptions("Env.create", options, {
                packages: []
            });
            options = result.options;

            if (options.packages.length === 0) {
                throw new CondaError("Env.create: at least one package required");
            }

            var data = options.data;
            var cmdList = ['create'];
            cmdList = cmdList.concat(options.cmdList);
            cmdList = cmdList.concat(options.packages);
        };

        // FIXME: Not sure I get this API.
        // FIXME: I don't think this return works as expected
        Env.getEnvs = function() {
            return info().then(function(info) {
                var envs = [new Env('root', info.default_prefix)];

                var prefixes = info.envs;
                for (var i = 0; i < prefixes.length; i++) {
                    var prefix = prefixes[i];
                    var name = prefix.split('/'); // TODO Windows?
                    name = name[name.length - 1];
                    envs.push(new Env(name, prefix));
                }

                envs.forEach(function(env) {
                    env.isDefault = env.prefix == info.default_prefix;
                    env.isRoot = env.prefix == info.root_prefix;
                });
                return envs;
            });
        };
        return Env;
    })();

    var Package = (function() {
        function Package(fn, info) {
            this.fn = fn;
            this.info = info;
        }

        Package.load = function(fn) {
            return api(['info', fn + '.tar.bz2'], 'get', ['info', fn + '.tar.bz2']).then(function(info) {
                info = info[fn + '.tar.bz2'];
                var pkg = new Package(fn, info);
                return pkg;
            });
        };

        return Package;
    })();

    var Config = (function() {
        var _warn_result = function(result) {
            if (result.warnings && result.warnings.length) {
                console.log("Warnings for conda config:");
                console.log(result.warnings);
            }
            return result;
        };
        var _merge = function(dest, src) {
            for (var key in src) {
                if (src.hasOwnProperty(key)) {
                    dest[key] = src[key];
                }
            }

            return dest;
        };
        var ALLOWED_KEYS = ['channels', 'disallow', 'create_default_packages',
            'track_features', 'envs_dirs', 'always_yes', 'allow_softlinks', 'changeps1',
            'use_pip', 'binstar_upload', 'binstar_personal', 'show_channel_urls',
            'allow_other_channels', 'ssl_verify'];

        function Config(options) {
            options = defaultOptions(options, {
                system: false,
                file: null
            });
            this.system = options.system;
            this.file = options.file;
            this.data = {};
            this.cmdList = ['config'];

            if (options.system && options.file !== null) {
                throw new CondaError("Config: at most one of system, file allowed");
            }

            if (options.system) {
                this.cmdList.push('--system');
                this.data.system = true;
            }
            else if (options.file !== null) {
                this.cmdList.push('--file');
                this.cmdList.push(options.file);
                this.data.file = options.file;
            }
        }

        Config.prototype.rcPath = function() {
            var call = api(this.cmdList.concat(['--get']),
                           'get', ['config', 'getAll'], this.data);
            return call.then(function(result) {
                return result.rc_path;
            });
        };

        Config.prototype.get = function(key) {
            if (ALLOWED_KEYS.indexOf(key) === -1) {
                throw new CondaError(
                    "Config.get: key " + key + " not allowed. Key must be one of "
                        + ALLOWED_KEYS.join(', '));
            }
            var call = api(this.cmdList.concat(['--get', key]),
                           'get', ['config', 'getAll', key], this.data);

            // FIXME: Shouldn't this return another Promise that operates on result
            //        instead?  Returning inside this Promise doesn't get back to
            //        calling code as best I can tell.
            return call.then(function(result) {
                if (result.warnings.length) {
                    console.log("Warnings for conda config:");
                    console.log(result.warnings);
                }
                if (typeof result.get[key] !== "undefined") {
                    return {
                        value: result.get[key],
                        set: true
                    };
                }
                else {
                    return {
                        value: undefined,
                        set: false
                    };
                }
            });
        };

        Config.prototype.getAll = function() {
            var call = api(this.cmdList.concat(['--get']),
                           'get', ['config', 'getAll'], this.data);
            return call.then(function(result) {
                return result.get;
            });
        };

        // TODO disallow non iterable keys
        Config.prototype.add = function(key, value) {
            // FIXME: This code is repeated a lot -- could use refactoring into a common decorator
            if (ALLOWED_KEYS.indexOf(key) === -1) {
                throw new CondaError(
                    "Config.set: key " + key + " not allowed. Key must be one of "
                        + ALLOWED_KEYS.join(', '));
            }
            // TODO use PUT? (should be idempotent)
            var call = api(this.cmdList.concat(['--add', key, value, '--force']),
                           'post', ['config', 'add', key],
                           _merge({ value: value }, this.data));
            return call.then(_warn_result);
        };

        Config.prototype.set = function(key, value) {
            if (ALLOWED_KEYS.indexOf(key) === -1) {
                throw new CondaError(
                    "Config.set: key " + key + " not allowed. Key must be one of "
                        + ALLOWED_KEYS.join(', '));
            }
            var call = api(this.cmdList.concat(['--set', key, value, '--force']),
                           'post', ['config', 'set', key],
                           _merge({ value: value }, this.data));
            return call.then(_warn_result);
        };

        Config.prototype.remove = function(key, value) {
            if (ALLOWED_KEYS.indexOf(key) === -1) {
                throw new CondaError(
                    "Config.remove: key " + key + " not allowed. Key must be one of "
                        + ALLOWED_KEYS.join(', '));
            }
            var call = api(this.cmdList.concat(['--remove', key, value, '--force']),
                           'post', ['config', 'remove', key],
                           _merge({ value: value }, this.data));
            return call.then(_warn_result);
        };

        Config.prototype.removeKey = function(key) {
            var call = api(this.cmdList.concat(['--remove-key', key, value, '--force']),
                           'post', ['config', 'removeKey', key]);
            return call.then(_warn_result);
        };

        return Config;
    })();

    var info = function() {
        return api(['info'], 'get', ['info']);
    };

    var search = function(options) {
        options = defaultOptions(options, {
            regex: null,
            spec: null
        });
        var cmdList = ['search'];

        if (options.regex && options.spec) {
            throw new CondaError("conda.search: only one of regex and spec allowed");
        }

        if (options.regex !== null) {
            cmdList.push(regex);
        }
        if (options.spec !== null) {
            cmdList.push(spec);
            cmdList.push('--spec');
        }
        return api(cmdList, 'get', cmdList);
    };

    var launch = function(command) {
        return api(['launch', command], 'get', ['launch', command]);
    };

    var clean = function(options) {
        options = defaultOptions(options, {});
        var cmdList = makeFlags(options, {
            dryRun: false,
            indexCache: false,
            lock: false,
            tarballs: false,
            packages: false
        });

        if (!(indexCache || lock || tarballs || packages)) {
            throw new CondaError("conda.clean: at least one of indexCache, lock, tarballs, or packages required");
        }

        // FIXME: The API we talked about looks like:
        //            api('clean', {"indexCache": true, "tarballs": true})
        //        That should simplify the call into api() since it'll be responsible
        //        for turning that into something to execute on.  Should also make
        //        testing easier, as it can be tested directly.
        return api(['clean'].concat(cmdList), 'post', ['clean'], options);
    };

    return {
        clean: clean,
        info: info,
        launch: launch,
        search: search,
        CondaError: CondaError,
        Config: Config,
        Env: Env,
        Package: Package,
        API_ROOT: '/api/',
        DEV_SERVER: false
    };
}
