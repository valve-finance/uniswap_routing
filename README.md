# Uniswap V2 Route Optimization
This work is part of Uniswap's grant program. It will focus on the Uniswap V2 protocol, but aims for extensibilty to Uniswap V3.

## Planned Deliverables
* A dashboard illustrating the default routes recommended by Uniswap vs. a computed optimal route based on:
  * Pool liquidity
  * Gas fees
  * Trade size
* An API that returns the default recommended route and computed optimal route

## Tentative Schedule by Week
### May 16 - May 22, 2021 Stagy 1: Groundwork & Project Setup
- [] Basic Project Setup & Dependency Setup
- [] Integrate with Uniswap Route API
### May 23 - May 29, 2021 Stage 2: Swap Modelling
- [] Construct Graph DB Instance with all possible swaps
- [] Focus on 100 swaps and crystalize their possible routes
- [] Extract route dependencies
- [] API to manipulate the 100 swaps, regenerate routes, and re-extract dependencies
### May 30 - Jun 05, 2021 Stage 3: Model liquidity with continuous updates
- [] Integrate a datasource of swap liquidity 
- [] Continuously update the 100 swap's route dependencies liquidity
### Jun 06 - Jun 12, 2021 Stage 4: Determine optimal routing
- [] Consider liquidity and gas fees (number of hops)
### Jun 13 - Jun 19, 2021 Stage 5: Results Dashboard
- [] Publish route comparison results to dashboard
### Jun 20 - Jun 26, 2021: Stage 6: API
- [] Make an API available that provides both default and optimal routes with extended data
### Jun 27 - Jul 03, 2021

