// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IFlapBoostPortal {
    struct ExactInputParams {
        address inputToken;
        address outputToken;
        uint256 inputAmount;
        uint256 minOutputAmount;
        bytes permitData;
    }

    struct QuoteExactInputParams {
        address inputToken;
        address outputToken;
        uint256 inputAmount;
    }

    function swapExactInput(ExactInputParams calldata params) external payable returns (uint256 outputAmount);

    function quoteExactInput(QuoteExactInputParams calldata params) external returns (uint256 outputAmount);
}

interface IFlapBoostTriggerService {
    struct TriggerRequest {
        address requester;
        uint64 executeAfter;
        uint8 status;
        uint128 feePaid;
    }

    function requestTrigger(uint64 executeAfter) external payable returns (uint256 requestId);

    function getFee() external view returns (uint256 gasFee);

    function getRequest(uint256 requestId) external view returns (TriggerRequest memory request);
}

interface IFlapBoostTriggerReceiver {
    function trigger(uint256 requestId) external;
}
