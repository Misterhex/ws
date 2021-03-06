/*!
 * ws: a node.js websocket client
 * Copyright(c) 2011 Einar Otto Stangvik <einaros@gmail.com>
 * MIT Licensed
 */

'use strict';

const EventEmitter = require('events');
const crypto = require('crypto');
const Ultron = require('ultron');
const http = require('http');
const util = require('util');
const url = require('url');

const PerMessageDeflate = require('./PerMessageDeflate');
const Extensions = require('./Extensions');
const WebSocket = require('./WebSocket');

/**
 * Create a `WebSocketServer` instance.
 *
 * @param {Object} options Configuration options
 * @param {String} options.host The hostname where to bind the server
 * @param {Number} options.port The port where to bind the server
 * @param {http.Server} options.server A pre-created HTTP/S server to use
 * @param {Function} options.verifyClient An hook to reject connections
 * @param {Function} options.handleProtocols An hook to handle protocols
 * @param {String} options.path Accept only connections matching this path
 * @param {Boolean} options.noServer Enable no server mode
 * @param {Boolean} options.clientTracking Specifies whether or not to track clients
 * @param {(Boolean|Object)} options.perMessageDeflate Enable/disable permessage-deflate
 * @param {Number} options.maxPayload The maximum allowed message size
 * @param {Function} callback A listener for the `listening` event
 * @constructor
 * @public
 */
function WebSocketServer (options, callback) {
  if (this instanceof WebSocketServer === false) {
    return new WebSocketServer(options, callback);
  }

  EventEmitter.call(this);

  options = Object.assign({
    host: '0.0.0.0',
    port: null,
    server: null,
    verifyClient: null,
    handleProtocols: null,
    path: null,
    noServer: false,
    clientTracking: true,
    perMessageDeflate: true,
    maxPayload: 100 * 1024 * 1024,
    backlog: null // use default (511 as implemented in net.js)
  }, options);

  if (options.port == null && !options.server && !options.noServer) {
    throw new TypeError('missing or invalid options');
  }

  if (options.port != null) {
    this._server = http.createServer((req, res) => {
      const body = http.STATUS_CODES[426];

      res.writeHead(426, {
        'Content-Length': body.length,
        'Content-Type': 'text/plain'
      });
      res.end(body);
    });
    this._server.allowHalfOpen = false;
    this._server.listen(options.port, options.host, options.backlog, callback);
  } else if (options.server) {
    this._server = options.server;
  }

  if (this._server) {
    this._ultron = new Ultron(this._server);
    this._ultron.on('listening', () => this.emit('listening'));
    this._ultron.on('error', (err) => this.emit('error', err));
    this._ultron.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head, (client) => {
        this.emit(`connection${req.url}`, client);
        this.emit('connection', client);
      });
    });
  }

  if (options.clientTracking) this.clients = new Set();
  this.options = options;
  this.path = options.path;
}

util.inherits(WebSocketServer, EventEmitter);

/**
 * Close the server.
 *
 * @param {Function} cb Callback
 * @public
 */
WebSocketServer.prototype.close = function (cb) {
  // terminate all associated clients
  if (this.clients) {
    for (const client of this.clients) client.terminate();
  }

  if (this._server) {
    // close the http server if it was internally created
    if (this.options.port != null) this._server.close(cb);
    this._ultron.destroy();
    this._ultron = this._server = null;
  } else if (cb) {
    cb();
  }
};

/**
 * See if a given request should be handled by this server instance.
 *
 * @param {http.IncomingMessage} req Request object to inspect
 * @return {Boolean} `true` if the request is valid, else `false`
 * @public
 */
WebSocketServer.prototype.shouldHandle = function (req) {
  if (this.options.path && url.parse(req.url).pathname !== this.options.path) {
    return false;
  }

  return true;
};

/**
 * Handle a HTTP Upgrade request.
 *
 * @param {http.IncomingMessage} req The request object
 * @param {net.Socket} socket The network socket between the server and client
 * @param {Buffer} head The first packet of the upgraded stream
 * @param {Function} cb Callback
 * @public
 */
WebSocketServer.prototype.handleUpgrade = function (req, socket, head, cb) {
  if (
    !this.shouldHandle(req) ||
    !req.headers.upgrade ||
    req.headers.upgrade.toLowerCase() !== 'websocket' ||
    !req.headers['sec-websocket-key']
  ) {
    return abortConnection(socket, 400);
  }

  socket.on('error', socketError);
  upgrade.apply(this, arguments);
};

module.exports = WebSocketServer;

/**
 * Handle premature socket errors.
 *
 * @private
 */
function socketError () {
  this.destroy();
}

/**
 * Upgrade the connection to WebSocket.
 *
 * @param {http.IncomingMessage} req The request object
 * @param {net.Socket} socket The network socket between the server and client
 * @param {Buffer} head The first packet of the upgraded stream
 * @param {Function} cb Callback
 * @private
 */
function upgrade (req, socket, head, cb) {
  const version = +req.headers['sec-websocket-version'];

  if (version !== 8 && version !== 13) return abortConnection(socket, 400);

  var protocol = (req.headers['sec-websocket-protocol'] || '').split(/, */);

  // handler to call when the connection sequence completes
  const completeUpgrade = () => {
    // calc key
    const key = crypto.createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, 'binary')
      .digest('base64');

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${key}`
    ];

    if (protocol) {
      headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
    }

    const offer = Extensions.parse(req.headers['sec-websocket-extensions']);
    var extensions;

    try {
      extensions = acceptExtensions.call(this, offer);
    } catch (err) {
      return abortConnection(socket, 400);
    }

    if (Object.keys(extensions).length) {
      const serverExtensions = Object.keys(extensions).reduce((obj, key) => {
        obj[key] = [extensions[key].params];
        return obj;
      }, {});

      headers.push(`Sec-WebSocket-Extensions: ${Extensions.format(serverExtensions)}`);
    }

    // allows external modification/inspection of handshake headers
    this.emit('headers', headers);

    if (socket.writable) {
      socket.write(headers.concat('', '').join('\r\n'));
    } else {
      socket.destroy();
      return;
    }

    const client = new WebSocket([req, socket, head], {
      maxPayload: this.options.maxPayload,
      protocolVersion: version,
      extensions,
      protocol
    });

    if (this.clients) {
      this.clients.add(client);
      client.on('close', () => this.clients.delete(client));
    }

    // signal upgrade complete
    socket.removeListener('error', socketError);
    cb(client);
  };

  // optionally call external protocol selection handler
  if (this.options.handleProtocols) {
    protocol = this.options.handleProtocols(protocol);
    if (protocol === false) return abortConnection(socket, 401);
  } else {
    protocol = protocol[0];
  }

  // optionally call external client verification handler
  if (this.options.verifyClient) {
    const info = {
      origin: req.headers[`${version === 8 ? 'sec-websocket-origin' : 'origin'}`],
      secure: !!(req.connection.authorized || req.connection.encrypted),
      req
    };

    if (this.options.verifyClient.length === 2) {
      this.options.verifyClient(info, (verified, code, message) => {
        if (!verified) return abortConnection(socket, code || 401, message);

        completeUpgrade();
      });
      return;
    } else if (!this.options.verifyClient(info)) {
      return abortConnection(socket, 401);
    }
  }

  completeUpgrade();
}

function acceptExtensions (offer) {
  var extensions = {};
  var options = this.options.perMessageDeflate;
  var maxPayload = this.options.maxPayload;
  if (options && offer[PerMessageDeflate.extensionName]) {
    var perMessageDeflate = new PerMessageDeflate(options !== true ? options : {}, true, maxPayload);
    perMessageDeflate.accept(offer[PerMessageDeflate.extensionName]);
    extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
  }
  return extensions;
}

/**
 * Close the connection when preconditions are not fulfilled.
 *
 * @param {net.Socket} socket The socket of the upgrade request
 * @param {Number} code The HTTP response status code
 * @param {String} [message] The HTTP response body
 * @api private
 */
function abortConnection (socket, code, message) {
  if (socket.writable) {
    message = message || http.STATUS_CODES[code];
    socket.write(
      `HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\n` +
      'Connection: close\r\n' +
      'Content-type: text/html\r\n' +
      `Content-Length: ${Buffer.byteLength(message)}\r\n` +
      '\r\n' +
      message
    );
  }
  socket.destroy();
}
