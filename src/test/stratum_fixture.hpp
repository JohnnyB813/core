#pragma once
#include "block/header/generator.hpp"
#include "block/header/header_impl.hpp"
#include "crypto/address.hpp"
#include "general/hex.hpp"
#include <algorithm>
#include <stdexcept>

namespace stratum_fixture {
inline Address address(size_t index)
{
    std::array<uint8_t, 20> bytes {};
    bytes[0] = 0x72;
    bytes[18] = uint8_t(index >> 8);
    bytes[19] = uint8_t(index);
    return Address(bytes);
}

// Notification fixtures only: the transfers are synthetic and not signed.
// No fixture block is submitted to consensus or sent to peers.
inline Block block(const Address& payout, size_t transfers,
    NonzeroHeight height = NonzeroHeight { uint32_t(1) })
{
    if (transfers > 300) throw std::runtime_error("fixture transfer limit");
    std::vector<uint8_t> bytes(48 + (transfers ? 4 + 99 * transfers : 0), 0);
    bytes[11] = 1; // one new address, after the ten-byte mining seed
    std::copy(payout.begin(), payout.end(), bytes.begin() + 12);
    bytes[39] = 1; // reward account ID
    bytes[44] = 3; // deterministic nonzero reward bytes
    if (transfers) {
        bytes[50] = uint8_t(transfers >> 8);
        bytes[51] = uint8_t(transfers);
        for (size_t i = 52; i < bytes.size(); ++i)
            bytes[i] = uint8_t(i * 131 + payout[19]);
    }
    BodyContainer body(std::move(bytes));
    auto view = body.view(height);
    if (!view.valid())
        throw std::runtime_error("invalid notification fixture");
    Hash previous {};
    previous.fill(0x31);
    HeaderGenerator generator(previous, view, TargetV2::genesis_testnet(), 1700000000, height);
    return { height, generator.serialize(0), std::move(body), {} };
}
}
