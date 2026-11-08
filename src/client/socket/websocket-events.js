(function (root) {
    'use strict';

    var HEARTBEAT = 20000;
    var REQUEST_TIMEOUT = 15000;
    var WORKER_TIMEOUT = 5000;
    var PERSONAL = 'user';

    var script = root.document.currentScript;
    var config = {
        endpoint: script.getAttribute('data-endpoint'),
        worker: script.getAttribute('data-worker'),
        connection: script.getAttribute('data-connection'),
        user: /^\d+$/.test(script.getAttribute('data-user') || '') ? Number(script.getAttribute('data-user')) : null
    };

    var handlers = {};
    var subscribed = {};
    var statusListeners = [];
    var status = {state: 'idle', user: null};
    var requests = {};
    var nextRequest = 1;
    var transport = null;

    function channels() {
        return Object.keys(handlers);
    }

    function receive(message) {
        var data = message || {};
        switch (data.type) {
            case 'status':
                status = {state: data.state, user: data.user};
                if (status.state !== 'open') {
                    subscribed = {};
                }
                if (status.state === 'open' && status.user !== config.user) {
                    refuse(PERSONAL, 'account_changed');
                }
                statusListeners.slice().forEach(function (listener) {
                    listener(status);
                });
                return;
            case 'event':
                if (data.ch === PERSONAL && status.user !== config.user) {
                    return;
                }
                (handlers[data.ch] || []).slice().forEach(function (handler) {
                    handler.onEvent({type: data.t, data: data.d});
                });
                return;
            case 'subscription':
                if (!data.ok) {
                    refuse(data.ch, data.code);
                    return;
                }
                if (handlers[data.ch]) {
                    subscribed[data.ch] = true;
                    handlers[data.ch].slice().forEach(confirm);
                }
                return;
            case 'reply':
                settle(data.id, data.ok, data.code, data.d);
                return;
        }
    }

    function refuse(name, code) {
        var refused = handlers[name];
        if (!refused) {
            return;
        }
        delete handlers[name];
        delete subscribed[name];
        if (transport) {
            transport.unsub(name);
        }
        refused.forEach(function (handler) {
            if (handler.onError) {
                handler.onError(code);
            }
        });
    }

    function confirm(handler) {
        if (handler.onSubscribed) {
            handler.onSubscribed();
        }
    }

    function settle(id, ok, code, data) {
        var request = requests[id];
        if (!request) {
            return;
        }
        delete requests[id];
        clearTimeout(request.timer);
        if (ok) {
            request.resolve(data);
        } else {
            request.reject(new Error(code || 'failed'));
        }
    }

    function workerTransport() {
        if (typeof root.SharedWorker !== 'function' || !config.worker) {
            return null;
        }
        var worker;
        try {
            worker = new root.SharedWorker(config.worker, {name: 'websocket-events:' + config.endpoint, extendedLifetime: true});
        } catch (error) {
            return null;
        }
        var port = worker.port;
        var heartbeat = setInterval(function () {
            port.postMessage({type: 'alive', channels: channels()});
        }, HEARTBEAT);
        var self = {
            sub: function (name) {
                port.postMessage({type: 'sub', ch: name});
            },
            unsub: function (name) {
                port.postMessage({type: 'unsub', ch: name});
            },
            send: function (id, name, type, data) {
                port.postMessage({type: 'send', id: id, ch: name, t: type, d: data});
            },
            check: function () {
                port.postMessage({type: 'check'});
            },
            dispose: function () {
                clearInterval(heartbeat);
                port.postMessage({type: 'detach'});
                port.close();
            }
        };
        function fallBack() {
            clearTimeout(silence);
            if (transport === self) {
                self.dispose();
                transport = directTransport();
            }
        }
        var silence = setTimeout(fallBack, WORKER_TIMEOUT);
        port.onmessage = function (message) {
            clearTimeout(silence);
            receive(message.data);
        };
        worker.onerror = fallBack;
        port.start();
        port.postMessage({type: 'hello', user: config.user});

        return self;
    }

    function directTransport() {
        var connection = null;
        var disposed = false;
        var self = {
            sub: function (name) {
                if (connection) {
                    connection.subscribe(name);
                }
            },
            unsub: function (name) {
                if (connection) {
                    connection.unsubscribe(name);
                }
            },
            send: function (id, name, type, data) {
                if (!connection) {
                    settle(id, false, 'offline');
                    return;
                }
                connection.send(name, type, data).then(function (reply) {
                    settle(id, true, null, reply);
                }, function (error) {
                    settle(id, false, error.message);
                });
            },
            check: function () {
                if (connection) {
                    connection.check();
                }
            },
            dispose: function () {
                disposed = true;
                if (connection) {
                    connection.close();
                }
            }
        };

        whenConnectionLoaded(function () {
            if (disposed) {
                return;
            }
            connection = root.WebSocketEventsConnection.createConnection({
                url: (root.location.protocol === 'https:' ? 'wss://' : 'ws://') + root.location.host + config.endpoint,
                sessionUrl: config.endpoint + '/session',
                WebSocket: root.WebSocket,
                fetch: function (url) {
                    return root.fetch(url, {credentials: 'same-origin', cache: 'no-store'}).then(function (response) {
                        return response.ok ? response.json() : Promise.reject(new Error(String(response.status)));
                    });
                },
                on: {
                    status: function (state, user) {
                        receive({type: 'status', state: state, user: user});
                    },
                    subscription: function (name, ok, code) {
                        receive({type: 'subscription', ch: name, ok: ok, code: code});
                    },
                    event: function (name, type, data) {
                        receive({type: 'event', ch: name, t: type, d: data});
                    }
                }
            });
            connection.expectUser(config.user);
            channels().forEach(self.sub);
        });

        return self;
    }

    function whenConnectionLoaded(callback) {
        if (root.WebSocketEventsConnection) {
            callback();
            return;
        }
        var element = root.document.createElement('script');
        element.src = config.connection;
        element.onload = callback;
        root.document.head.appendChild(element);
    }

    function ensureTransport() {
        if (transport === null) {
            transport = workerTransport() || directTransport();
        }

        return transport;
    }

    root.WebSocketEvents = {
        subscribe: function (name, onEvent, onError, onSubscribed) {
            var handler = {onEvent: onEvent, onError: onError, onSubscribed: onSubscribed};
            var list = handlers[name];
            if (!list) {
                list = handlers[name] = [];
                list.push(handler);
                ensureTransport().sub(name);
            } else {
                list.push(handler);
                if (subscribed[name]) {
                    setTimeout(function () {
                        if (subscribed[name] && handlers[name] && handlers[name].indexOf(handler) !== -1) {
                            confirm(handler);
                        }
                    }, 0);
                }
            }

            return function () {
                var current = handlers[name];
                var index = current ? current.indexOf(handler) : -1;
                if (index === -1) {
                    return;
                }
                current.splice(index, 1);
                if (current.length === 0) {
                    delete handlers[name];
                    delete subscribed[name];
                    if (transport) {
                        transport.unsub(name);
                    }
                }
            };
        },

        send: function (name, type, data) {
            return new Promise(function (resolve, reject) {
                var id = String(nextRequest++);
                requests[id] = {
                    resolve: resolve,
                    reject: reject,
                    timer: setTimeout(function () {
                        settle(id, false, 'timeout');
                    }, REQUEST_TIMEOUT)
                };
                ensureTransport().send(id, name, type, data);
            });
        },

        onStatus: function (listener) {
            statusListeners.push(listener);
            listener(status);

            return function () {
                var index = statusListeners.indexOf(listener);
                if (index !== -1) {
                    statusListeners.splice(index, 1);
                }
            };
        }
    };

    function check() {
        if (transport) {
            transport.check();
        }
    }

    root.addEventListener('online', check);
    root.document.addEventListener('visibilitychange', function () {
        if (root.document.visibilityState === 'visible') {
            check();
        }
    });
    root.addEventListener('pagehide', function () {
        if (transport) {
            transport.dispose();
            transport = null;
        }
        subscribed = {};
    });
    root.addEventListener('pageshow', function (event) {
        if (event.persisted && transport === null && channels().length > 0) {
            channels().forEach(ensureTransport().sub);
        }
    });
}(window));
