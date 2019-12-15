const bio = require("bufio");
const util = require("./util");

//Create a constructor that sets all of the data, and then we can call that in the indexer.
//
//
//Chart data currently available.
//1. Average Daily difficulty.
//2. Transactions per Day.
//3. Total supply per day.
//4. Total burned
class ChartData extends bio.Struct {
  //move this to from blockData, and then make the contrustor empty
  constructor(entry, block, chainState) {
    super();
    //Time of data.
    this.time = 0;
    //Double
    this.difficulty = 0;
    this.transactions = 0;
    this.supply = 0;
    this.burned = 0;
    this.totalTx = 0;
  }

  fromBlockData(entry, block, chainState) {
    this.time = entry.time || 0;
    //Double
    this.difficulty = util.toDifficulty(entry.bits) || 0;
    this.transactions = block.txs.length || 0;
    this.supply = chainState.value || 0;
    this.burned = chainState.burned || 0;
    this.totalTx = chainState.tx || 0;
    return this;
  }

  write(bw) {
    bw.writeDouble(this.difficulty);
    bw.writeU32(this.transactions);
    bw.writeU64(this.supply);
    bw.writeU64(this.burned);
    bw.writeU64(this.totalTx);
    return bw;
  }

  read(br) {
    this.time = 0;
    this.difficulty = br.readDouble();
    this.transactions = br.readU32();
    this.supply = br.readU64();
    this.burned = br.readU64();
    this.totalTx = br.readU64();
    return this;
  }

  fromObject(data) {
    this.time = data.time || 0;
    this.difficulty = data.difficulty || 0;
    this.transactions = data.transactions || 0;
    this.supply = data.supply || 0;
    this.burned = data.burned || 0;
    this.totalTx = data.totalTx || 0;
    return this;
  }

  //creates average chart data from an array of chart data elements.
  static fromArray(data) {
    let sums = data.reduce(function(a, b) {
      return {
        difficulty: a.difficulty + b.difficulty,
        transactions: a.transactions + b.transactions,
        supply: Math.max(a.supply, b.supply),
        burned: Math.max(a.burned, b.burned),
        totalTx: Math.max(a.totalTx, b.totalTx)
      };
    });

    //We want average difficulty.
    sums.difficulty /= data.length;
    //make the time the UTC midnight of that day.
    sums.time = Math.floor(data[0].time / (3600 * 24));

    //@todo return new this().fromObject(sums);
    // return sums;
    return new this().fromObject(sums);
  }

  static fromBlockData(entry, block, state) {
    return new this().fromBlockData(entry, block, state);
  }
}

module.exports.ChartData = ChartData;
