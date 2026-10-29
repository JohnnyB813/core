#include "chainserver/state/state.hpp"
#include <array>
#include <cstdint>
#include <stdexcept>
#include <vector>

static void check(bool value)
{
    if (!value) throw std::runtime_error("mining cache lookup differs from inserted body");
}

static Address payout(unsigned n)
{
    std::array<uint8_t, 20> bytes {};
    bytes[0] = uint8_t(n >> 8);
    bytes[1] = uint8_t(n);
    return Address(bytes);
}

int main()
{
    chainserver::MiningCache cache({ 1, 2, 3 });
    for (unsigned n = 0; n < 128; ++n) {
        cache.insert(payout(n), false, BodyContainer(std::vector<uint8_t> { uint8_t(n) }));
        for (unsigned prior = 0; prior <= n; ++prior) {
            const auto* body = cache.lookup(payout(prior), false);
            check(body && body->data() == std::vector<uint8_t> { uint8_t(prior) });
        }
    }
    cache.insert(payout(80), true, BodyContainer(std::vector<uint8_t> { 200 }));
    check(cache.lookup(payout(80), true)->data() == std::vector<uint8_t> { 200 });
    check(cache.lookup(payout(80), false)->data() == std::vector<uint8_t> { 80 });
    check(cache.lookup(payout(200), false) == nullptr);
    cache.update_validity({ 1, 2, 3 });
    check(cache.lookup(payout(80), true) != nullptr);
    cache.update_validity({ 1, 2, 4 });
    check(cache.lookup(payout(80), true) == nullptr);
    check(cache.lookup(payout(80), false) == nullptr);
}
