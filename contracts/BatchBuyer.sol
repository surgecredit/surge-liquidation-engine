// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IAuctionHouse {
    function buy(uint256 nftId_, bytes calldata btcAddress_) external;
}

interface IVaultManager {
    function checkHealth(uint256 nftId_) external;
}

interface IERC721 {
    function transferFrom(address from, address to, uint256 tokenId) external;
}

/**
 * Buys several Surge liquidation auctions in a single transaction.
 *
 * The engine's previous approach was one transaction per auction, which meant
 * one nonce per auction: gaps, races and per-transaction retries were all
 * possible failure modes, and nothing was atomic. Here N auctions cost one
 * nonce and land in one block, so those failure modes cannot occur at all.
 *
 * `checkHealth` (which opens an auction) and `buy` run in the same transaction,
 * closing the window in which a competing keeper could buy an auction this
 * wallet just paid gas to open.
 *
 * Custody: USDC is NOT parked here. `run` pulls a budget from the owner, spends
 * what the buys need, and returns the remainder in the same transaction, so
 * between runs the funds sit in the owner's wallet. The owner only grants this
 * contract a USDC allowance -- the same trust shape as the allowance the
 * AuctionHouse already holds.
 */
contract BatchBuyer {
    address public immutable owner;
    IAuctionHouse public immutable house;
    IVaultManager public immutable vault;
    IERC20 public immutable usdc;

    /// ok=false means that id was skipped; the rest of the batch still ran.
    event Opened(uint256 indexed nftId, bool ok);
    event Bought(uint256 indexed nftId, bool ok);

    error NotOwner();
    error PullFailed();
    error RefundFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address house_, address vault_, address usdc_) {
        owner = msg.sender;
        house = IAuctionHouse(house_);
        vault = IVaultManager(vault_);
        usdc = IERC20(usdc_);
        // One-time max approval: `buy` pulls USDC from msg.sender, which is
        // this contract. Approving per run would add a transaction back.
        IERC20(usdc_).approve(house_, type(uint256).max);
    }

    /**
     * Open `openIds` and buy `buyIds`, all in this one transaction.
     *
     * Every call is wrapped in try/catch: a position that is no longer
     * liquidatable, or an auction another keeper already won, must not revert
     * the whole batch and lose the rest. Failures surface as `ok=false` events.
     *
     * @param openIds    positions to checkHealth (open an auction for)
     * @param buyIds     auctions to buy; usually openIds plus any already open
     * @param btcAddress payout address for the seized BTC, as raw bytes
     * @param budget     USDC (base units) to pull from the owner for this run;
     *                   whatever is unspent is returned before this call ends
     */
    function run(
        uint256[] calldata openIds,
        uint256[] calldata buyIds,
        bytes calldata btcAddress,
        uint256 budget
    ) external onlyOwner {
        if (budget > 0) {
            if (!usdc.transferFrom(owner, address(this), budget)) revert PullFailed();
        }

        for (uint256 i; i < openIds.length; ++i) {
            try vault.checkHealth(openIds[i]) {
                emit Opened(openIds[i], true);
            } catch {
                emit Opened(openIds[i], false);
            }
        }

        for (uint256 i; i < buyIds.length; ++i) {
            try house.buy(buyIds[i], btcAddress) {
                emit Bought(buyIds[i], true);
            } catch {
                emit Bought(buyIds[i], false);
            }
        }

        // Never leave USDC sitting here between runs.
        uint256 left = usdc.balanceOf(address(this));
        if (left > 0) {
            if (!usdc.transfer(owner, left)) revert RefundFailed();
        }
    }

    /// Escape hatch for any token that ends up stranded here.
    function rescue(address token, uint256 amount) external onlyOwner {
        if (!IERC20(token).transfer(owner, amount)) revert RefundFailed();
    }

    /**
     * Accept ERC721s. If the AuctionHouse hands the position NFT to the buyer
     * with `safeTransferFrom`, a contract that does not implement this reverts
     * the transfer -- and because `run` wraps each buy in try/catch, that would
     * surface as every buy silently failing rather than as an error. Cheap
     * insurance against a failure mode that would otherwise be hard to read.
     */
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    /// Counterpart to `rescue` for any ERC721 that lands here.
    function rescueNft(address token, uint256 tokenId) external onlyOwner {
        IERC721(token).transferFrom(address(this), owner, tokenId);
    }
}
