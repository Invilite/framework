(function (root) {
    'use strict';

    var PORT_TIMEOUT = 180000;
    var SWEEP_INTERVAL = 60000;

    function createRouter(options) {
        var timers = options.timers || {setInterval: setInterval.bind(root), now: Date.now};
        var ports = [];
        var channelPorts = {};
        var confirmed = {};
        var status = {state: 'idle', user: null};

        var connection = options.createConnection({
            status: function (state, user) {
                status = {state: state, user: user};
                if (state !== 'open') {
                    confirmed = {};
                }
                broadcast({type: 'status', state: state, user: user});
            },
            identity: function (user) {
                status.user = user;
            },
            subscription: function (name, ok, code) {
                if (ok && channelPorts[name]) {
                    confirmed[name] = true;
                }
                each(channelPorts[name], function (entry) {
                    post(entry, {type: 'subscription', ch: name, ok: ok, code: code});
                });
                if (!ok) {
                    each(channelPorts[name], function (entry) {
                        delete entry.channels[name];
                    });
                    delete channelPorts[name];
                }
            },
            event: function (name, type, data) {
                each(channelPorts[name], function (entry) {
                    post(entry, {type: 'event', ch: name, t: type, d: data});
                });
            }
        });

        function each(list, callback) {
            if (list) {
                list.slice().forEach(callback);
            }
        }

        function post(entry, message) {
            try {
                entry.port.postMessage(message);
            } catch (error) {
                remove(entry, true);
            }
        }

        function broadcast(message) {
            ports.slice().forEach(function (entry) {
                post(entry, message);
            });
        }

        function find(port) {
            for (var i = 0; i < ports.length; i++) {
                if (ports[i].port === port) {
                    return ports[i];
                }
            }

            return null;
        }

        function add(port) {
            var entry = {port: port, channels: {}, seen: timers.now()};
            ports.push(entry);
            post(entry, {type: 'status', state: status.state, user: status.user});

            return entry;
        }

        function join(entry, name) {
            if (entry.channels[name]) {
                return;
            }
            entry.channels[name] = true;
            var list = channelPorts[name] || (channelPorts[name] = []);
            list.push(entry);
            if (list.length === 1) {
                delete confirmed[name];
                connection.subscribe(name);
            } else if (confirmed[name]) {
                post(entry, {type: 'subscription', ch: name, ok: true, code: null});
            }
        }

        function leave(entry, name) {
            if (!entry.channels[name]) {
                return;
            }
            delete entry.channels[name];
            var list = channelPorts[name] || [];
            var index = list.indexOf(entry);
            if (index !== -1) {
                list.splice(index, 1);
            }
            if (list.length === 0) {
                delete channelPorts[name];
                delete confirmed[name];
                connection.unsubscribe(name);
            }
        }

        function remove(entry, close) {
            var index = ports.indexOf(entry);
            if (index === -1) {
                return;
            }
            ports.splice(index, 1);
            Object.keys(entry.channels).forEach(function (name) {
                leave(entry, name);
            });
            if (close) {
                try {
                    entry.port.close();
                } catch (error) {
                }
            }
        }

        function sync(entry, channels) {
            var keep = {};
            channels.forEach(function (name) {
                keep[name] = true;
                join(entry, name);
            });
            Object.keys(entry.channels).forEach(function (name) {
                if (!keep[name]) {
                    leave(entry, name);
                }
            });
        }

        function handle(port, message) {
            var data = message || {};
            if (data.type === 'detach') {
                var leaving = find(port);
                if (leaving) {
                    remove(leaving, true);
                }
                return;
            }
            var entry = find(port) || add(port);
            entry.seen = timers.now();

            switch (data.type) {
                case 'hello':
                    connection.expectUser(typeof data.user === 'number' ? data.user : null);
                    return;
                case 'alive':
                    sync(entry, Array.isArray(data.channels) ? data.channels : []);
                    return;
                case 'sub':
                    join(entry, data.ch);
                    return;
                case 'unsub':
                    leave(entry, data.ch);
                    return;
                case 'check':
                    connection.check();
                    return;
                case 'send':
                    connection.send(data.ch, data.t, data.d).then(function (reply) {
                        post(entry, {type: 'reply', id: data.id, ok: true, code: null, d: reply});
                    }, function (error) {
                        post(entry, {type: 'reply', id: data.id, ok: false, code: error.message});
                    });
                    return;
            }
        }

        function sweep() {
            var limit = timers.now() - PORT_TIMEOUT;
            ports.slice().forEach(function (entry) {
                if (entry.seen < limit) {
                    remove(entry, false);
                }
            });
        }

        timers.setInterval(sweep, SWEEP_INTERVAL);

        return {
            connect: function (port) {
                port.onmessage = function (message) {
                    handle(port, message.data);
                };
                port.start();
                add(port);
            },
            check: function () {
                connection.check();
            },
            handle: handle,
            sweep: sweep,
            portCount: function () {
                return ports.length;
            }
        };
    }

    var api = {createRouter: createRouter};
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
        return;
    }

    var location = new URL(root.location.href);
    var endpoint = location.pathname.replace(/\/client\/[^/]*$/, '');
    root.importScripts(endpoint + '/client/websocket-events-connection.js?v=' + encodeURIComponent(location.searchParams.get('c') || '1'));

    var router = createRouter({
        createConnection: function (on) {
            return root.WebSocketEventsConnection.createConnection({
                url: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + endpoint,
                sessionUrl: endpoint + '/session',
                WebSocket: root.WebSocket,
                fetch: function (url) {
                    return root.fetch(url, {credentials: 'same-origin', cache: 'no-store'}).then(function (response) {
                        return response.ok ? response.json() : Promise.reject(new Error(String(response.status)));
                    });
                },
                on: on
            });
        }
    });
    root.onconnect = function (event) {
        router.connect(event.ports[0]);
    };
    root.addEventListener('online', function () {
        router.check();
    });
}(typeof self !== 'undefined' ? self : this));
