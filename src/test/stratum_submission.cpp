#include "api/stratum/stratum_server.hpp"
#include "stratum_fixture.hpp"
#include <iostream>

static void check(bool value, const char* message)
{
    if (!value) throw std::runtime_error(message);
}
static void compare(const Block& original, bool legacy)
{
    stratum::Job job { Block(original) };
    for (bool clean : {false, true})
        check(stratum::prepare_work("job", original, clean) == stratum::prepare_work("job", job, clean),
            "cached notification changed its bytes");
    for (unsigned i = 0; i < 100; ++i) {
        std::array<uint8_t, 4> prefix {uint8_t(i), 0x12, 0x34, 0x56};
        std::array<uint8_t, 6> extra {uint8_t(i * 17), 0x78, 0x9a, 0xbc, 0xde, 0xff};
        std::array<uint8_t, 4> timestamp {0x65, 0x53, 0xf1, uint8_t(i)};
        std::array<uint8_t, 4> nonce {0x01, 0x23, 0x45, uint8_t(i)};
        if (legacy) std::copy_n(original.body.data().begin() + 4, 6, extra.begin());
        auto reference = original;
        std::copy(prefix.begin(), prefix.end(), reference.body.data().begin());
        std::copy(extra.begin(), extra.end(), reference.body.data().begin() + 4);
        reference.header.set_merkleroot(reference.body_view().merkle_root(reference.height));
        reference.header.set_timestamp(timestamp); reference.header.set_nonce(nonce);
        check(job.submission(prefix, extra, timestamp, nonce) == reference,
            "cached submission differs from full-root reference");
        check(job.block() == original, "submission mutated its cached job");
    }
}
int main(int argc, char** argv) try
{
    check(argc == 2, "expected mainnet or testnet");
    const bool testnet = std::string(argv[1]) == "testnet";
    if (testnet) enable_testnet();
    for (unsigned height : testnet ? std::vector<unsigned>{1, 2, 3, 8192}
                                  : std::vector<unsigned>{NEWBLOCKSTRUCUTREHEIGHT, JANUSV8BLOCKV3START,
                                        JANUSV8BLOCKV3START + 1, 5184400}) {
        for (unsigned n : {0, 1, 2, 3, 10, 100, 300}) {
            auto original = stratum_fixture::block(stratum_fixture::address(n), n, NonzeroHeight(height));
            compare(original, false);
            // Existing payout, so only one reward leaf in an empty body.
            if (n == 0) {
                auto bytes = original.body.data();
                bytes.erase(bytes.begin() + 12, bytes.begin() + 32); bytes[11] = 0;
                original.body = BodyContainer(std::move(bytes));
                compare(original, false);
            }
        }
    }
    if (!testnet) for (unsigned height : {1u, NEWMERKLEROOT - 1, NEWMERKLEROOT, NEWBLOCKSTRUCUTREHEIGHT - 1}) {
        std::vector<uint8_t> bytes(50, 0); bytes[7] = 1; // legacy address count
        auto address = stratum_fixture::address(1);
        std::copy(address.begin(), address.end(), bytes.begin() + 8);
        BodyContainer body(std::move(bytes));
        Header header; header.fill(0);
        compare(Block {NonzeroHeight(height), header, std::move(body), {}}, true);
    }
    std::cout << argv[1] << ": cached roots, exact submissions and notification bytes passed\n";
} catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
