// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import '@uniswap/lib/contracts/libraries/FixedPoint.sol';
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";
import "@uniswap/v2-periphery/contracts/libraries/UniswapV2OracleLibrary.sol";
import "./PriceLibrary.sol";
import "./Math.sol";

struct OracleStore {
    uint224 basePriceCumulative;
    uint32  blockTimestamp;
}

library OracleLibrary {
    using FixedPoint for FixedPoint.uq112x112;

    function fetchPrice(
        OracleStore storage self,
        IUniswapV2Pair pool,
        uint quoteTokenIndex
    )
        public
        returns (Price memory price)
    {
        if (self.blockTimestamp == block.timestamp) {
            return price;   // return empty price if no time has passed
        }

        (uint price0Cumulative, uint price1Cumulative, uint32 blockTimestamp) =
            UniswapV2OracleLibrary.currentCumulativePrices(address(pool));

        if (blockTimestamp == self.blockTimestamp) {
            return price;   // return empty price if the price is up-to-date
        }

        uint basePriceCumulative = quoteTokenIndex == 0 ? price1Cumulative : price0Cumulative;
        uint basePrice = (basePriceCumulative - self.basePriceCumulative) / (blockTimestamp - self.blockTimestamp);
        price.base = FixedPoint.uq112x112(uint224(basePrice));

        uint256 totalSupply = pool.totalSupply();
        (uint r0, uint r1, ) = pool.getReserves();

        // k = r0 * r1
        // quotePrice = 1
        /// 2 * sqrt(basePrice * k) / supply
        price.LP = FixedPoint.fraction(2 * Math.sqrt(r0 * r1), totalSupply).muluq(price.base.sqrt());

        // sync
        self.basePriceCumulative = uint224(basePriceCumulative);    // TODO: overflow?
        self.blockTimestamp = blockTimestamp;
    }
}
