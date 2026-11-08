(function (root) {
    'use strict';

    var PING_INTERVAL = 25000;
    var PONG_TIMEOUT = 10000;
    var BACKOFF_BASE = 1000;
    var BACKOFF_CAP = 30000;
    var REQUEST_TIMEOUT = 10000;
    var LINGER = 10000;
    var CLOSE_REVOKED = 4401;
    var RATE_RETRY = 2000;

    function createConnection(options) {
        var SocketClass = options.WebSocket;
        var fetchSession = options.fetch;
        var timers = options.timers || {setTimeout: setTimeout.bind(root), clearTimeout: clearTimeout.bind(root)};
        var random = options.random || Math.random;
        var on = options.on || {};

        var socket = null;
        var ready = false;
        var state = 'idle';
        var user;
        var expectedUser;
        var identityChecked = false;
        var wanted = {};
        var attempts = 0;
        var retryTimer = null;
        var pingTimer = null;
        var pongTimer = null;
        var lingerTimer = null;
        var requests = {};
        var nextRequest = 1;
        var stopped = false;

        function emit(name) {
            var handler = on[name];
            if (typeof handler === 'function') {
                handler.apply(null, Array.prototype.slice.call(arguments, 1));
            }
        }

        function setState(next) {
            if (state !== next) {
                state = next;
                emit('status', state, user === undefined ? null : user);
            }
        }

        function hasWanted() {
            for (var name in wanted) {
                if (Object.prototype.hasOwnProperty.call(wanted, name)) {
                    return true;
                }
            }

            return false;
        }

        function write(frame) {
            if (socket && ready) {
                socket.send(JSON.stringify(frame));
                return true;
            }

            return false;
        }

        function clearTimer(timer) {
            if (timer !== null) {
                timers.clearTimeout(timer);
            }

            return null;
        }

        function connect() {
            retryTimer = clearTimer(retryTimer);
            if (stopped || socket || !hasWanted()) {
                return;
            }
            setState('connecting');
            try {
                socket = new SocketClass(options.url);
            } catch (error) {
                socket = null;
                scheduleReconnect();
                return;
            }
            var current = socket;
            current.onmessage = function (message) {
                if (current === socket) {
                    receive(message.data);
                }
            };
            current.onclose = function (event) {
                if (current === socket) {
                    lost(event && event.code);
                }
            };
            pongTimer = timers.setTimeout(function () {
                if (current === socket && !ready) {
                    abandon();
                }
            }, PONG_TIMEOUT);
        }

        function scheduleReconnect() {
            if (stopped || !hasWanted()) {
                setState('idle');
                return;
            }
            if (retryTimer !== null) {
                return;
            }
            setState('offline');
            var delay = random() * Math.min(BACKOFF_CAP, BACKOFF_BASE * Math.pow(2, attempts));
            attempts += 1;
            retryTimer = timers.setTimeout(function () {
                retryTimer = null;
                connect();
            }, delay);
        }

        function abandon() {
            var dead = socket;
            if (!dead) {
                return;
            }
            dead.onmessage = null;
            dead.onclose = null;
            try {
                dead.close();
            } catch (error) {
            }
            lost(null);
        }

        function lost(code) {
            socket = null;
            ready = false;
            pingTimer = clearTimer(pingTimer);
            pongTimer = clearTimer(pongTimer);
            for (var id in requests) {
                if (Object.prototype.hasOwnProperty.call(requests, id)) {
                    settle(id, false, 'offline');
                }
            }
            if (code === CLOSE_REVOKED) {
                identityChecked = false;
            }
            scheduleReconnect();
        }

        function receive(text) {
            var frame;
            try {
                frame = JSON.parse(text);
            } catch (error) {
                return;
            }
            if (!frame || typeof frame.op !== 'string') {
                return;
            }
            pongTimer = clearTimer(pongTimer);

            switch (frame.op) {
                case 'hello':
                    hello(typeof frame.user === 'number' ? frame.user : null);
                    return;
                case 'subscribed':
                    emit('subscription', frame.ch, true, null);
                    return;
                case 'event':
                    emit('event', frame.ch, frame.t, frame.d);
                    return;
                case 'ack':
                    settle(frame.id, true, null, frame.d);
                    return;
                case 'error':
                    if (frame.id) {
                        settle(frame.id, false, frame.code);
                    } else if (frame.code === 'rate_limited' && frame.ch && wanted[frame.ch]) {
                        retrySubscribe(frame.ch);
                    } else if (frame.ch && wanted[frame.ch]) {
                        delete wanted[frame.ch];
                        emit('subscription', frame.ch, false, frame.code);
                    }
                    return;
            }
        }

        function hello(connectedAs) {
            if (expectedUser !== undefined && connectedAs !== expectedUser) {
                if (!identityChecked) {
                    identityChecked = true;
                    checkSession();
                    return;
                }
            }
            identityChecked = false;
            if (user !== connectedAs) {
                user = connectedAs;
                emit('identity', user);
            }
            expectedUser = connectedAs;
            ready = true;
            attempts = 0;
            setState('open');
            for (var name in wanted) {
                if (Object.prototype.hasOwnProperty.call(wanted, name)) {
                    write({op: 'sub', ch: name});
                }
            }
            schedulePing();
        }

        function checkSession() {
            var dead = socket;
            dead.onmessage = null;
            dead.onclose = null;
            socket = null;
            pongTimer = clearTimer(pongTimer);
            try {
                dead.close();
            } catch (error) {
            }
            setState('connecting');
            fetchSession(options.sessionUrl).then(function (body) {
                expectedUser = body && typeof body.user === 'number' ? body.user : null;
                connect();
            }, function () {
                identityChecked = false;
                scheduleReconnect();
            });
        }

        function retrySubscribe(name) {
            timers.setTimeout(function () {
                if (wanted[name]) {
                    write({op: 'sub', ch: name});
                }
            }, RATE_RETRY);
        }

        function schedulePing() {
            pingTimer = clearTimer(pingTimer);
            pingTimer = timers.setTimeout(function () {
                pingTimer = null;
                ping();
                schedulePing();
            }, PING_INTERVAL);
        }

        function ping() {
            if (!socket || !ready || pongTimer !== null) {
                return;
            }
            write({op: 'ping'});
            pongTimer = timers.setTimeout(function () {
                pongTimer = null;
                abandon();
            }, PONG_TIMEOUT);
        }

        function abandonQuietly() {
            var dead = socket;
            if (dead) {
                dead.onmessage = null;
                dead.onclose = null;
                try {
                    dead.close(1000);
                } catch (error) {
                }
            }
            socket = null;
            ready = false;
            pingTimer = clearTimer(pingTimer);
            pongTimer = clearTimer(pongTimer);
            for (var id in requests) {
                if (Object.prototype.hasOwnProperty.call(requests, id)) {
                    settle(id, false, 'offline');
                }
            }
            setState('idle');
        }

        function settle(id, ok, code, data) {
            var request = requests[id];
            if (!request) {
                return;
            }
            delete requests[id];
            timers.clearTimeout(request.timer);
            if (ok) {
                request.resolve(data);
            } else {
                request.reject(new Error(code || 'failed'));
            }
        }

        return {
            subscribe: function (name) {
                lingerTimer = clearTimer(lingerTimer);
                if (wanted[name]) {
                    return;
                }
                wanted[name] = true;
                if (!write({op: 'sub', ch: name})) {
                    connect();
                }
            },

            unsubscribe: function (name) {
                if (!wanted[name]) {
                    return;
                }
                delete wanted[name];
                write({op: 'unsub', ch: name});
                if (!hasWanted() && lingerTimer === null) {
                    lingerTimer = timers.setTimeout(function () {
                        lingerTimer = null;
                        if (!hasWanted()) {
                            retryTimer = clearTimer(retryTimer);
                            abandonQuietly();
                        }
                    }, LINGER);
                }
            },

            send: function (name, type, data) {
                return new Promise(function (resolve, reject) {
                    if (!socket || !ready) {
                        reject(new Error('offline'));
                        return;
                    }
                    var id = String(nextRequest++);
                    write({op: 'send', ch: name, t: type, d: data, id: id});
                    requests[id] = {
                        resolve: resolve,
                        reject: reject,
                        timer: timers.setTimeout(function () {
                            settle(id, false, 'timeout');
                        }, REQUEST_TIMEOUT)
                    };
                });
            },

            expectUser: function (id) {
                expectedUser = id;
                identityChecked = false;
                if (ready && user !== id) {
                    abandon();
                }
            },

            check: function () {
                if (socket && ready) {
                    ping();
                } else if (!socket && hasWanted()) {
                    attempts = 0;
                    connect();
                }
            },

            state: function () {
                return state;
            },

            close: function () {
                stopped = true;
                retryTimer = clearTimer(retryTimer);
                lingerTimer = clearTimer(lingerTimer);
                abandonQuietly();
            }
        };
    }

    var api = {createConnection: createConnection};
    root.WebSocketEventsConnection = api;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
}(typeof self !== 'undefined' ? self : this));
