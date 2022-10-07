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

const opts = {
  gasLimit: 30000000
}

describe("Lock", function () {
  // We define a fixture to reuse the same setup in every test.
  // We use loadFixture to run this setup once, snapshot that state,
  // and reset Hardhat Network to that snapshot in every test.
  async function deployOneYearLockFixture() {
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
      numberToWei(10),
      numberToWei(10),
      '1000000000000000',
      '1000000000000000',
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

    return {token0, token1, uniswapRouter, owner, initPrice, pairAddresses, testpriceContract}
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
    it("when price is increased, the difference of twap price < difference of naive price after a little time", async function () {
      const {
        token0,
        token1,
        owner,
        pairAddresses,
        uniswapRouter,
        testpriceContract,
        initPrice
      } = await loadFixture(deployOneYearLockFixture);
      await time.increase(100)
      // swap to change price
      const tx = await uniswapRouter.swapExactTokensForTokens(
        numberToWei(10),
        0,
        [token0.address, token1.address],
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

      // check the price is increased
      expect(initPrice.naive_base).to.lessThan(price2.naive_base)
      expect(initPrice.naive_LP).to.lessThan(price2.naive_LP)
    });

    it("when price is increased, the difference of twap price < difference of naive price after many time", async function () {
      const {
        token0,
        token1,
        owner,
        pairAddresses,
        uniswapRouter,
        testpriceContract,
        initPrice
      } = await loadFixture(deployOneYearLockFixture);
      await time.increase(100)

      // swap to change price
      const tx1 = await uniswapRouter.swapExactTokensForTokens(
        numberToWei(10),
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

      // check the price is increased
      expect(initPrice.naive_base).to.lessThan(price2.naive_base)
      expect(initPrice.naive_LP).to.lessThan(price2.naive_LP)
    });

    it("when price is increased, the difference of twap price after a little time < difference of twap price after many time", async function () {
      const {
        token0,
        token1,
        owner,
        pairAddresses,
        uniswapRouter,
        testpriceContract,
        initPrice
      } = await loadFixture(deployOneYearLockFixture);
      await time.increase(100)

      // swap to change price
      const tx1 = await uniswapRouter.swapExactTokensForTokens(
        numberToWei(10),
        0,
        [token0.address, token1.address],
        owner.address,
        new Date().getTime() + 10000,
        opts
      )
      await tx1.wait(1)

      // get price after 10s
      await time.increase(100);
      const price2 = formatFetchPriceResponse(await testpriceContract.callStatic.testFetchPrice(pairAddresses, token0.address));


      // get price after 1000000s
      await time.increase(1000000);
      const price3 = formatFetchPriceResponse(await testpriceContract.callStatic.testFetchPrice(pairAddresses, token0.address));


      // check the difference of twap price < difference of naive price
      expect(getDiffPercent(initPrice.twap_base, price2.twap_base)).to.lessThan(getDiffPercent(initPrice.twap_base, price3.twap_base));
      expect(getDiffPercent(initPrice.twap_LP, price2.twap_LP)).to.lessThan(getDiffPercent(initPrice.twap_LP, price3.twap_LP));

      // check the price is increased
      expect(initPrice.naive_base).to.lessThan(price2.naive_base)
      expect(initPrice.naive_LP).to.lessThan(price2.naive_LP)
      expect(initPrice.naive_base).to.lessThan(price3.naive_base)
      expect(initPrice.naive_LP).to.lessThan(price3.naive_LP)
    });

    it("when price is decreased, the difference of twap price < difference of naive price after a little time", async function () {
      const {
        token0,
        token1,
        owner,
        pairAddresses,
        uniswapRouter,
        testpriceContract,
        initPrice
      } = await loadFixture(deployOneYearLockFixture);
      await time.increase(100)
      // swap to change price
      const tx = await uniswapRouter.swapExactTokensForTokens(
        numberToWei(10),
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

      // check the price is decreased
      expect(initPrice.naive_base).to.greaterThan(price2.naive_base)
      expect(initPrice.naive_LP).to.greaterThan(price2.naive_LP)
    });

    it("when price is decreased, the difference of twap price < difference of naive price after many times", async function () {
      const {
        token0,
        token1,
        owner,
        pairAddresses,
        uniswapRouter,
        testpriceContract,
        initPrice
      } = await loadFixture(deployOneYearLockFixture);
      await time.increase(100)

      // swap to change price
      const tx1 = await uniswapRouter.swapExactTokensForTokens(
        numberToWei(10),
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

      // check the difference of twap price < difference of naive price
      expect(getDiffPercent(initPrice.twap_base, price2.twap_base)).to.lessThan(getDiffPercent(initPrice.naive_base, price2.naive_base));
      expect(getDiffPercent(initPrice.twap_LP, price2.twap_LP)).to.lessThan(getDiffPercent(initPrice.naive_LP, price2.naive_LP));

      // check the price is decreased
      expect(initPrice.naive_base).to.greaterThan(price2.naive_base)
      expect(initPrice.naive_LP).to.greaterThan(price2.naive_LP)
    });

    it("when price is decreased, the difference of twap price after a little time < difference of twap price after many time", async function () {
      const {
        token0,
        token1,
        owner,
        pairAddresses,
        uniswapRouter,
        testpriceContract,
        initPrice
      } = await loadFixture(deployOneYearLockFixture);
      await time.increase(100)

      // swap to change price
      const tx1 = await uniswapRouter.swapExactTokensForTokens(
        numberToWei(10),
        0,
        [token1.address, token0.address],
        owner.address,
        new Date().getTime() + 10000,
        opts
      )
      await tx1.wait(1)

      // get price after 10s
      await time.increase(100);
      const price2 = formatFetchPriceResponse(await testpriceContract.callStatic.testFetchPrice(pairAddresses, token0.address));


      // get price after 1000000s
      await time.increase(1000000);
      const price3 = formatFetchPriceResponse(await testpriceContract.callStatic.testFetchPrice(pairAddresses, token0.address));

      // check the difference of twap price < difference of naive price
      expect(getDiffPercent(initPrice.twap_base, price2.twap_base)).to.lessThan(getDiffPercent(initPrice.twap_base, price3.twap_base));
      expect(getDiffPercent(initPrice.twap_LP, price2.twap_LP)).to.lessThan(getDiffPercent(initPrice.twap_LP, price3.twap_LP));

      // check the price is decreased
      expect(initPrice.naive_base).to.greaterThan(price2.naive_base)
      expect(initPrice.naive_LP).to.greaterThan(price2.naive_LP)
      expect(initPrice.naive_base).to.greaterThan(price3.naive_base)
      expect(initPrice.naive_LP).to.greaterThan(price3.naive_LP)
    });
  });
});
