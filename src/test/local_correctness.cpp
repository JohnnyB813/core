#include "api/interface.hpp"
#include "api/types/all.hpp"
#include "block/header/header_impl.hpp"
#include "eventloop/address_manager/flat_address_set.hpp"
#include "general/hex.hpp"
#include <algorithm>
#include <cstdio>
#include <cctype>
#include <iostream>
#include <numeric>
#include <random>
#include <set>
#include <stdexcept>

static void check(bool value, const char* message)
{
    if (!value) throw std::runtime_error(message);
}

static void addresses()
{
    std::vector<unsigned> order(6);
    std::iota(order.begin(), order.end(), 0);
    auto address = [](unsigned i) { return EndpointAddress(IPv4(i / 3 + 1), uint16_t(i % 3 + 9186)); };
    auto compare = [&](auto& actual, const auto& expected) {
        check(actual.size() == expected.size(), "address count differs from reference set");
        check(std::equal(actual.data().begin(), actual.data().end(), expected.begin(), expected.end()),
            "address set lost sorted, unique contents");
        for (unsigned i = 0; i < 24; ++i)
            check(actual.contains(address(i)) == expected.contains(address(i)), "address lookup differs");
    };
    do {
        address_manager::FlatAddressSet actual;
        std::set<EndpointAddress> expected;
        for (auto i : order) {
            auto a = address(i);
            actual.insert(a); expected.insert(a); compare(actual, expected);
            actual.insert(a); compare(actual, expected);
        }
        for (auto i : order) {
            actual.erase(address(i)); expected.erase(address(i)); compare(actual, expected);
            actual.erase(address(i)); compare(actual, expected);
        }
    } while (std::next_permutation(order.begin(), order.end()));
    std::mt19937 random(0x481624);
    address_manager::FlatAddressSet actual;
    std::set<EndpointAddress> expected;
    for (unsigned i = 0; i < 10000; ++i) {
        auto a = address(random() % 24);
        if (random() & 1) { actual.insert(a); expected.insert(a); }
        else { actual.erase(a); expected.erase(a); }
        compare(actual, expected);
    }
    actual.clear(); expected.clear(); compare(actual, expected);
}

static void janushash()
{
    auto invoke = [](const std::string& input, const std::string& expected) {
        unsigned count = 0;
        std::string result;
        get_janushash_number(input, [&](const API::Raw& value) { ++count; result = value.s; });
        check(count == 1, "Janushash request did not call back exactly once");
        check(result == expected, "Janushash response changed");
    };
    Header header;
    for (size_t i = 0; i < header.size(); ++i) header[i] = uint8_t(i * 71 + 3);
    for (uint32_t version : {1, 2, 3, 7}) {
        const auto offset = HeaderView::offset_version;
        header[offset] = header[offset + 1] = header[offset + 2] = 0;
        header[offset + 3] = uint8_t(version);
        char expected[35];
        std::snprintf(expected, sizeof(expected), "%.20e", header.janus_number());
        auto hex = serialize_hex(header);
        invoke(hex, expected);
        std::transform(hex.begin(), hex.end(), hex.begin(), [](char c) { return char(std::toupper(c)); });
        invoke(hex, expected);
        for (size_t i : {size_t(0), hex.size() / 2, hex.size() - 1}) {
            auto invalid = hex; invalid[i] = 'g'; invoke(invalid, "");
        }
        invoke(hex.substr(1), ""); invoke(hex + "0", ""); invoke(hex + "00", "");
    }
    invoke("", ""); invoke("invalid", "");
}

int main(int argc, char** argv) try
{
    check(argc == 2, "expected addresses or janushash group");
    if (std::string(argv[1]) == "addresses") addresses();
    else if (std::string(argv[1]) == "janushash") janushash();
    else throw std::runtime_error("unknown local correctness group");
    std::cout << argv[1] << " regressions passed\n";
} catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
