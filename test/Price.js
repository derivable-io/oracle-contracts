const {
  time,
  loadFixture,
} = require("@nomicfoundation/hardhat-network-helpers");
const {expect} = require("chai");

const LARGE_VALUE =
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'
const bn = ethers.BigNumber.from

const numberToWei = (number, decimal = 18) => {
  return ethers.utils.parseUnits(number.toString(), decimal)
}

const weiToNumber = (number, decimal = 18) => {
  return ethers.utils.formatUnits(number.toString(), decimal)
}

const opts = {
  gasLimit: 30000000
}

const ONE = ethers.BigNumber.from(1);
const TWO = ethers.BigNumber.from(2);

const calculateSwapToPrice = async (pool, targetPrice, quoteToken) => {
  targetPrice = numberToWei(targetPrice)

  const [[r0, r1], token0, token1] = await Promise.all([
    pool.getReserves(),
    pool.token0(),
    pool.token1()
  ])
  const [rb, rq] = quoteToken === token0 ? [r1, r0] : [r0, r1];
  const oldPrice = rq.mul(numberToWei(1)).div(rb)
  let [rI, rO] = [rb, rq]
  let tokenInput = quoteToken === token0 ? token1 : token0

  if (targetPrice.gt(oldPrice)) {
    [rI, rO] = [rq, rb]
    tokenInput = quoteToken === token0 ? token0 : token1
  }
  let amount

  if (targetPrice.gt(oldPrice)) {
    const a = bn(997)
    const b = rI.mul(1000).add(rq.mul(997))
    const c1 = rq.mul(rI).mul(1000)
    const c2 = targetPrice.mul(rI).mul(rb).mul(1000).div(numberToWei(1))

    const {x1, x2} = quadraticEquation(a, b, c1.sub(c2))
    amount = x1.isNegative() ? x2 : x1
  } else {
    const a = 997
    const b = rb.mul(997).add(rI.mul(1000))
    const c1 = rb.mul(rI).mul(1000)
    const c2 = rq.mul(rI).mul(1000).mul(numberToWei(1)).div(targetPrice)
    const c = c1.sub(c2)
    const {x1, x2} = quadraticEquation(bn(a), b, c)
    amount = x1.isNegative() ? x2 : x1
  }

  return {
    tokenInput,
    amount
  }
}

function sqrt(value) {
  const x = ethers.BigNumber.from(value);
  let z = x.add(ONE).div(TWO);
  let y = x;
  while (z.sub(y).isNegative()) {
    y = z;
    z = x.div(z).add(z).div(TWO);
  }
  return y;
}


function quadraticEquation(a, b, c) {
  var x1, x2;
  // delta = b^2 - 4ac
  const delta = b.mul(b).sub(bn(4).mul(a).mul(c))
  if (delta.isZero()) {
    x1 = undefined
    x2 = undefined
  } else if (delta.lt(0)) {
    // x1 = x2 = -sqrt(delta) / 2a
    x1 = bn(0).sub(sqrt(delta)).div(a.mul(2))
    x2 = bn(0).sub(sqrt(delta)).div(a.mul(2))
  } else {
    // x1 = (-b - sqrt(delta)) / 2a
    // x2 = (-b + sqrt(delta)) / 2a
    x1 = bn(0).sub(b).add(sqrt(delta)).div(a.mul(2))
    x2 = bn(0).sub(b).sub(sqrt(delta)).div(a.mul(2))
  }
  return {x1, x2}
}

describe("Price Oracle", function () {
  // We define a fixture to reuse the same setup in every test.
  // We use loadFixture to run this setup once, snapshot that state,
  // and reset Hardhat Network to that snapshot in every test.
  async function deployPriceOracle() {
    const [owner, otherAccount] = await ethers.getSigners();

    // var provider = new ethers.providers.WebSocketProvider("ws://localhost:8545");
    var signer = owner;

    const compiledUniswapFactory = require("@uniswap/v2-core/build/UniswapV2Factory.json");
    var UniswapFactory = await new ethers.ContractFactory(compiledUniswapFactory.interface, compiledUniswapFactory.bytecode, signer);
    const compiledWETH = require("canonical-weth/build/contracts/WETH9.json")
    var WETH = await new ethers.ContractFactory(compiledWETH.abi, compiledWETH.bytecode, signer);

    const compiledUniswapRouter = require("@uniswap/v2-periphery/build/UniswapV2Router02");
    var UniswapRouter = await new ethers.ContractFactory(compiledUniswapRouter.abi, compiledUniswapRouter.bytecode, signer);

    const compiledERC20 = require("@uniswap/v2-core/build/ERC20.json");
    var erc20Factory = new ethers.ContractFactory(compiledERC20.abi, compiledERC20.bytecode, signer);

    var token0 = await erc20Factory.deploy(numberToWei(100000000));
    var token1 = await erc20Factory.deploy(numberToWei(100000000));
    var weth = await WETH.deploy();
    const uniswapFactory = await UniswapFactory.deploy(token0.address)
    const uniswapRouter = await UniswapRouter.deploy(uniswapFactory.address, weth.address)

    await token0.approve(uniswapRouter.address, LARGE_VALUE)
    await token1.approve(uniswapRouter.address, LARGE_VALUE)

    await uniswapRouter.addLiquidity(
      token0.address,
      token1.address,
      '9250619149041644050058396',
      '6986963283651477901852',
      '0',
      '0',
      owner.address,
      new Date().getTime() + 100000,
      opts
    )

    const pairAddresses = await uniswapFactory.allPairs(0)

    // deploy test price contract
    const Lib = await ethers.getContractFactory("OracleLibrary", signer);
    const lib = await Lib.deploy();
    await lib.deployed();
    const TestPrice = await ethers.getContractFactory("TestPrice", {
      signer,
      libraries: {
        OracleLibrary: lib.address,
      },
    });
    const testpriceContract = await TestPrice.deploy()
    await testpriceContract.deployed();

    token0.approve(uniswapRouter.address, LARGE_VALUE);
    token1.approve(uniswapRouter.address, LARGE_VALUE);

    // init pool store
    const tx = await testpriceContract.testFetchPrice(pairAddresses, token0.address);
    await tx.wait(1);

    // get price before update price
    // base price = 1, naive price = 1, cumulative price = 1
    const initPrice = formatFetchPriceResponse(await testpriceContract.callStatic.testFetchPrice(pairAddresses, token0.address));

    const poolContract = new ethers.Contract(pairAddresses, require("@uniswap/v2-core/build/UniswapV2Pair.json").abi, signer)

    return {token0, token1, uniswapRouter, poolContract, owner, initPrice, pairAddresses, testpriceContract}
  }

  function convertFixedToNumber(fixed) {
    const unit = 1000;

    return bn(fixed)
      .mul(unit)
      .div(bn(2).pow(112))
      .toNumber() / unit
  }

  function formatFetchPriceResponse(priceRes) {
    return {
      twap_base: convertFixedToNumber(priceRes.twap.base[0]),
      twap_LP: convertFixedToNumber(priceRes.twap.LP[0]),
      naive_base: convertFixedToNumber(priceRes.naive.base[0]),
      naive_LP: convertFixedToNumber(priceRes.naive.LP[0])
    }
  }

  function getDiffPercent(num1, num2) {
    return 100 * Math.abs(num1 - num2) / num1
  }

  describe("Deployment", function () {
    it("TWAP: price increased in a short time", async function () {
      const {
        token0,
        token1,
        owner,
        pairAddresses,
        uniswapRouter,
        testpriceContract,
        poolContract,
        initPrice
      } = await loadFixture(deployPriceOracle);
      await time.increase(100)
      // swap to change price

      const res = await calculateSwapToPrice(poolContract, 1600, token0.address)
      const tx = await uniswapRouter.swapExactTokensForTokens(
        res.amount,
        0,
        [res.tokenInput === token0.address ? token0.address : token1.address, res.tokenInput === token0.address ? token1.address : token0.address],
        owner.address,
        new Date().getTime() + 10000,
        opts
      )
      await tx.wait(1)

      const [r0, r1] = await poolContract.getReserves()

      console.log('price', weiToNumber(r0.mul(numberToWei(1)).div(r1)))

      // get price after 10s
      await time.increase(10);
      const price2 = formatFetchPriceResponse(await testpriceContract.callStatic.testFetchPrice(pairAddresses, token0.address));
      console.log({price2})

      // check the difference of twap price < difference of naive price
      expect(getDiffPercent(initPrice.twap_base, price2.twap_base)).to.lessThan(getDiffPercent(initPrice.naive_base, price2.naive_base));
      expect(getDiffPercent(initPrice.twap_LP, price2.twap_LP)).to.lessThan(getDiffPercent(initPrice.naive_LP, price2.naive_LP));

      expect(price2.twap_base).to.equal(1713.426);
      expect(price2.twap_LP).to.equal(82.851);
      expect(price2.naive_base).to.equal(5724.701);
      expect(price2.naive_LP).to.equal(151.441);
    });

    it("TWAP: price increased in a long time", async function () {
      const {
        token0,
        token1,
        owner,
        pairAddresses,
        uniswapRouter,
        testpriceContract,
        initPrice
      } = await loadFixture(deployPriceOracle);
      await time.increase(100)

      // swap to change price
      const tx1 = await uniswapRouter.swapExactTokensForTokens(
        numberToWei(10000000),
        0,
        [token0.address, token1.address],
        owner.address,
        new Date().getTime() + 10000,
        opts
      )
      await tx1.wait(1)

      // get price after 10s
      await time.increase(100000);
      const price2 = formatFetchPriceResponse(await testpriceContract.callStatic.testFetchPrice(pairAddresses, token0.address));

      // check the difference of twap price < difference of naive price
      expect(getDiffPercent(initPrice.twap_base, price2.twap_base)).to.lessThan(getDiffPercent(initPrice.naive_base, price2.naive_base));
      expect(getDiffPercent(initPrice.twap_LP, price2.twap_LP)).to.lessThan(getDiffPercent(initPrice.naive_LP, price2.naive_LP));

      expect(price2.twap_base).to.equal(5720.172);
      expect(price2.twap_LP).to.equal(151.381);
      expect(price2.naive_base).to.equal(5724.701);
      expect(price2.naive_LP).to.equal(151.441);
    });

    it("TWAP: price decreased in a short time", async function () {
      const {
        token0,
        token1,
        owner,
        pairAddresses,
        uniswapRouter,
        testpriceContract,
        initPrice
      } = await loadFixture(deployPriceOracle);
      await time.increase(100)
      // swap to change price
      const tx = await uniswapRouter.swapExactTokensForTokens(
        numberToWei(1000),
        0,
        [token1.address, token0.address],
        owner.address,
        new Date().getTime() + 10000,
        opts
      )
      await tx.wait(1)

      // get price after 10s
      await time.increase(10);
      const price2 = formatFetchPriceResponse(await testpriceContract.callStatic.testFetchPrice(pairAddresses, token0.address));

      // check the difference of twap price < difference of naive price
      expect(getDiffPercent(initPrice.twap_base, price2.twap_base)).to.lessThan(getDiffPercent(initPrice.naive_base, price2.naive_base));
      expect(getDiffPercent(initPrice.twap_LP, price2.twap_LP)).to.lessThan(getDiffPercent(initPrice.naive_LP, price2.naive_LP));

      expect(price2.twap_base).to.equal(1296.513);
      expect(price2.twap_LP).to.equal(72.027);
      expect(price2.naive_base).to.equal(1013.582);
      expect(price2.naive_LP).to.equal(63.685);
    });

    it("TWAP: price decreased in a long time", async function () {
      const {
        token0,
        token1,
        owner,
        pairAddresses,
        uniswapRouter,
        poolContract,
        testpriceContract,
        initPrice
      } = await loadFixture(deployPriceOracle);
      await time.increase(100)

      // swap to change price
      const tx1 = await uniswapRouter.swapExactTokensForTokens(
        numberToWei(1000),
        0,
        [token1.address, token0.address],
        owner.address,
        new Date().getTime() + 10000,
        opts
      )
      await tx1.wait(1)

      // get price after 10s
      await time.increase(100000);
      const price2 = formatFetchPriceResponse(await testpriceContract.callStatic.testFetchPrice(pairAddresses, token0.address));

      expect(price2.twap_base).to.equal(1013.901);
      expect(price2.twap_LP).to.equal(63.695);
      expect(price2.naive_base).to.equal(1013.582);
      expect(price2.naive_LP).to.equal(63.685);
    });
  });
});
