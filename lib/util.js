/*!
 * util.js - utils for hnscan
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * Copyright (c) 2018-2019, Handshake Alliance Developers (MIT License).
 * https://github.com/handshakealliance/hnscan-backend
 */

"use strict";

/**
 * @exports util
 */

const util = exports;

util.now = function now() {
  return Math.floor(Date.now() / 1000);
};

util.fromU32 = function fromU32(num) {
  const data = Buffer.allocUnsafe(4);
  data.writeUInt32LE(num, 0, true);
  return data;
};

util.toU32 = function toU32(buf) {
  const num = buf.readUInt32LE(0, true);
  return num;
};

/**
 * Sorts transactions in ascending order.
 */
util.sortTXs = function sortTXs(txs) {
  //Not sure how we can do this exactly to ensure that things are sorted especially if they
  // are the same block - XXX
  // For now will sort just in block order.
  //Also let's pass in some parameters here as right now
  // We are going to default to descending.

  txs.sort(function(a, b) {
    return b.height - a.height;
  });

  return txs;
};
