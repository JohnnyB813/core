// Offline socket-test support. The base is synthetic and deliberately has an
// easy target. Subsequent submissions use the unmodified node's complete checks.
// These funded public keys and databases must never be connected to a network.
#include "block/chain/consensus_headers.hpp"
#include "block/header/generator.hpp"
#include "block/header/header_impl.hpp"
#include "communication/create_payment.hpp"
#include "db/chain_db.hpp"
#include "general/hex.hpp"
#include "general/is_testnet.hpp"
#include "nlohmann/json.hpp"
#include <filesystem>
#include <fstream>
#include <iostream>

using json = nlohmann::json;
int main(int argc, char** argv) try
{
    enable_testnet();
    if (argc == 4 && std::string(argv[1]) == "solve") {
        auto bytes = hex_to_arr<80>(argv[2]); Header header; std::copy(bytes.begin(), bytes.end(), header.begin());
        const auto version = POWVersion::from_params(NonzeroHeight(uint32_t(std::stoul(argv[3]))), header.version(), true);
        for (uint32_t i = 0; i < 100000; ++i) {
            std::array<uint8_t, 4> nonce; std::memcpy(nonce.data(), &i, 4); header.set_nonce(nonce);
            if (static_cast<HeaderView>(header).validPOW(header.hash(), *version)) {
                std::cout << json{{"header",serialize_hex(header)},{"nonce",serialize_hex(nonce)}} << '\n'; return 0;
            }
        }
        throw std::runtime_error("fixture target did not yield a solution");
    }
    if (argc != 3 || std::string(argv[1]) != "seed") throw std::runtime_error("seed DIRECTORY or solve HEADER HEIGHT");
    ECC_Start();
    struct StopECC { ~StopECC() { ECC_Stop(); } } stopECC;
    const std::filesystem::path directory(argv[2]);
    std::filesystem::create_directories(directory);
    if (std::filesystem::exists(directory / "chain.db")) throw std::runtime_error("refusing to overwrite fixture database");
    BatchRegistry registry;
    ChainDB db((directory / "chain.db").string(), "wal");
    PrivKey signer("0000000000000000000000000000000000000000000000000000000000000001");
    PrivKey recipient("0000000000000000000000000000000000000000000000000000000000000002");
    PrivKey miner("0000000000000000000000000000000000000000000000000000000000000003");
    auto transaction = db.transaction();
    db.insertStateEntry(signer.pubkey().address(), Funds::from_value_throw(1000000), AccountId(1));
    db.insertStateEntry(recipient.pubkey().address(), Funds::zero(), AccountId(2));
    db.insertStateEntry(miner.pubkey().address(), Funds::zero(), AccountId(3));
    Batch batch;
    Hash previous = Hash::genesis();
    for (unsigned h = 1; h <= 3; ++h) {
        BodyContainer body(std::vector<uint8_t>(28, 0));
        HeaderGenerator generator(previous, body.view(NonzeroHeight(h)), TargetV2(1.0), 1700000000 + 20 * h, NonzeroHeight(h));
        auto header = generator.serialize(0);
        auto [id, inserted] = db.insert_protect(Block {NonzeroHeight(h), header, std::move(body), {}});
        if (!inserted) throw std::runtime_error("duplicate fixture block");
        db.insert_consensus(NonzeroHeight(h), id, HistoryId(1), AccountId(h == 1 ? 1 : 4));
        batch.append(header); previous = header.hash();
    }
    ExtendableHeaderchain chain(std::vector<Batch>{batch}, registry);
    db.set_consensus_work(chain.total_work()); transaction.commit();
    json requests = json::array();
    for (unsigned n = 0; n < 6000; ++n) {
        PaymentCreateMessage payment {PinHeight(Height(0)), Hash::genesis(), signer,
            CompactUInt::compact(Funds::from_value_throw(1)), recipient.pubkey().address(),
            Funds::from_value_throw(10), NonceId(n)};
        requests.push_back(json{{"pinHeight",0},{"nonceId",n},{"feeE8",1},{"amountE8",10},
            {"toAddr",recipient.pubkey().address().to_string()},{"signature65",payment.signature.to_string()}});
    }
    std::ofstream output(directory / "fixture.json");
    output << json{{"payout",miner.pubkey().address().to_string()},
        {"other_payout",recipient.pubkey().address().to_string()},{"requests",requests}};
    std::cout << "Offline Stratum fixture written\n";
} catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
