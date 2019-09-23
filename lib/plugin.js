/*!
 * plugin.js - hnscan plugin for hsd
 * Copyright (c) 2017-2019, Christopher Jeffrey (MIT License).
 * Copyright (c) 2018-2019, Handshake Alliance Developers (MIT License).
 * https://github.com/handshakealliance/hnscan-backend
 */

"use strict";

const EventEmitter = require("events");
const ChainClient = require("./chainclient");
const HnscanDB = require("./hnscandb.js");
const Indexer = require("./indexer.js");
const HTTP = require("./http");
const { Network } = require("hsd");
const Hnscan = require("./hnscan.js");

/**
 * @exports hnscan/plugin
 */

const plugin = exports;

/**
 * Plugin
 * @extends EventEmitter
 */

class Plugin extends EventEmitter {
  constructor(node) {
    super();

    this.config = node.config.filter("hnscan");
    this.config.open("hnscan.conf");

    this.network = Network.get(node.network.type);
    this.logger = node.logger;
    this.prefix = node.config.prefix;

    this.client = new ChainClient(node.chain);

    this.httpEnabled = this.config.bool("http-enabled", true);

    console.log("connecting to: %s", node.network);

    //Init DB here
    this.hdb = new HnscanDB({
      network: this.network,
      logger: this.logger,
      client: this.client,
      memory: this.config.bool("memory", node.memory),
      prefix: this.prefix,
      maxFiles: this.config.uint("max-files"),
      cacheSize: this.config.mb("cache-size")
    });

    this.indexer = new Indexer({
      network: this.network,
      logger: this.logger,
      client: this.client,
      hdb: this.hdb
    });

    this.hnscan = new Hnscan({
      network: this.network,
      logger: this.logger,
      hdb: this.hdb,
      chain: node.chain,
      //@todo I don't think we ever need client.
      client: this.client,
      node: node
    });

    this.http = new HTTP({
      network: this.network,
      logger: this.logger,
      hdb: this.hdb,
      client: this.client,
      node: node,
      hnscan: this.hnscan,
      // prefix: this.prefix,
      ssl: this.config.bool("ssl"),
      keyFile: this.config.path("ssl-key"),
      certFile: this.config.path("ssl-cert"),
      host: this.config.str("http-host"),
      port: this.config.uint("http-port"),
      apiKey: this.config.str("api-key", node.config.str("api-key")),
      noAuth: this.config.bool("no-auth"),
      cors: this.config.bool("cors", true)
    });

    this.init();
  }

  init() {
    this.hdb.on("error", err => this.emit("error", err));
    this.indexer.on("error", err => this.emit("error", err));
    this.http.on("error", err => this.emit("error", err));
  }

  //Going to open the http server here and the database
  async open() {
    await this.hdb.open();

    await this.indexer.open();

    await this.http.open();
  }

  //Close the db and the http server.
  async close() {}
}

/**
 * Plugin name.
 * @const {String}
 */

plugin.id = "hnscan";

/**
 * Plugin initialization.
 * @param {Node} node
 * @returns {Hnscan}
 */

plugin.init = function init(node) {
  return new Plugin(node);
};
