#include "api/interface.hpp"
#include "api/types/all.hpp"
#include "block/chain/header_chain.hpp"
#include "block/header/header_impl.hpp"
#include "general/byte_order.hpp"
#include "general/errors.hpp"
#include "general/is_testnet.hpp"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>

static void check(bool condition, const std::string& message)
{
    if (!condition) throw std::runtime_error(message);
}

struct SyntheticChain : Headerchain {
    void add(const Header& header, BatchRegistry& registry)
    {
        incompleteBatch.append(header);
        if (incompleteBatch.complete()) {
            finalPin = registry.share(std::move(incompleteBatch), finalPin);
            completeBatches.push_back(finalPin);
            incompleteBatch.clear();
        }
    }
    void finish() { initialize_worksum(); }
};

static double oracle_rate(const Headerchain& chain, uint32_t height, uint32_t window)
{
    if (height < 2) return 0;
    const uint32_t lower { height > window ? height - window : 1u };
    const auto firstTime { chain[NonzeroHeight(lower)].timestamp() };
    const auto lastTime { chain[NonzeroHeight(height)].timestamp() };
    if (firstTime >= lastTime)
        return double(std::numeric_limits<uint64_t>::max());
    Worksum work;
    for (uint32_t h = lower + 1; h <= height; ++h)
        work += Worksum(chain[NonzeroHeight(h)].target(NonzeroHeight(h), is_testnet()));
    return work.getdouble() / (lastTime - firstTime);
}

static void check_rate(const Headerchain& chain, uint32_t tip, uint32_t window)
{
    const auto expected { oracle_rate(chain, tip, window) };
    check(chain.hashrate(window) == static_cast<uint64_t>(expected),
        "scalar hashrate differs at height " + std::to_string(tip) + " window " + std::to_string(window));

    const uint32_t from { tip > 4 ? tip - 4 : 1u };
    const auto chart { chain.hashrate_chart(NonzeroHeight(from), NonzeroHeight(tip + 2), window) };
    const uint32_t first { std::max(2u, from) };
    if (tip < first) {
        check(chart.chart.empty(), "short chain should have an empty chart");
        return;
    }
    check(chart.range.begin == Height(first) && chart.range.end == Height(tip), "chart range differs");
    check(chart.chart.size() == tip - first + 1, "chart size differs");
    for (uint32_t h = first; h <= tip; ++h) {
        const auto actual { chart.chart[h - first] };
        const auto oracle { oracle_rate(chain, h, window) };
        check(std::abs(actual - oracle) <= std::max(1.0, std::abs(oracle)) * 1e-12,
            "chart hashrate differs at height " + std::to_string(h) + " window " + std::to_string(window));
    }
}

static void check_invalid_window()
{
    for (const size_t window : { size_t(0), size_t(std::numeric_limits<uint32_t>::max()) + 1 }) {
        bool scalarCalled { false };
        get_hashrate_n(window, [&](const auto& result) {
            scalarCalled = true;
            check(!result && result.error() == EINV_ARGS, "invalid scalar window was accepted");
        });
        check(scalarCalled, "invalid scalar window did not answer");

        bool chartCalled { false };
        get_hashrate_chart(NonzeroHeight(1u), NonzeroHeight(2u), window, [&](const auto& result) {
            chartCalled = true;
            check(!result && result.error() == EINV_ARGS, "invalid chart window was accepted");
        });
        check(chartCalled, "invalid chart window did not answer");
    }
}

int main() try
{
    enable_testnet();
    check_invalid_window();
    BatchRegistry registry;
    SyntheticChain chain;
    Hash previous { Hash::genesis() };
    Worksum oracleTotal;
    constexpr uint32_t tip = HEADERBATCHSIZE + 5;
    unsigned cases { 0 };
    for (uint32_t h = 1; h <= tip; ++h) {
        Header header {};
        header.fill(0);
        std::memcpy(header.data() + HeaderView::offset_prevhash, previous.data(), previous.size());
        const auto timestamp { hton32(1700000000u + h * 20u) };
        const auto target { TargetV2(1.0 + ((h - 1) / 720) % 4).binary() };
        std::memcpy(header.data() + HeaderView::offset_timestamp, &timestamp, sizeof(timestamp));
        std::memcpy(header.data() + HeaderView::offset_target, &target, sizeof(target));
        chain.add(header, registry);
        previous = header.hash();
        oracleTotal += Worksum(header.target(NonzeroHeight(h), is_testnet()));

        if (h != 1 && h != 2 && h != 718 && h != 719 && h != 720 && h != 721 &&
            h != 722 && h != 1440 && h != 1441 && h != HEADERBATCHSIZE &&
            h != HEADERBATCHSIZE + 1 && h != tip)
            continue;
        chain.finish();
        check(chain.total_work() == oracleTotal, "consensus work changed at height " + std::to_string(h));
        check(chain.total_work_at(Height(h)) == oracleTotal, "prefix work differs at height " + std::to_string(h));
        for (const uint32_t window : { 1u, 2u, 10u, 719u, 720u, 721u, tip + 10u }) {
            check_rate(chain, h, window);
            ++cases;
        }
        const auto empty { chain.hashrate_chart(NonzeroHeight(h + 1), NonzeroHeight(h + 2), 10) };
        check(empty.chart.empty(), "future chart range should be empty");
    }
    std::cout << "Hashrate reporting: " << cases
              << " scalar/chart windows, retargets, batch boundary and invalid inputs passed\n";
} catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
}
