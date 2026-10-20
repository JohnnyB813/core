// Local reconciliation regressions. Headers are synthetic and unmined; body
// application and signatures use the ordinary implementations. This is not a
// replacement for mainnet replay or full header/PoW interoperability tests.
#include "api/http/endpoint.hpp"
#include "api/types/all.hpp"
#include "block/body/generator.hpp"
#include "block/header/generator.hpp"
#include "block/header/header_impl.hpp"
#include "chainserver/state/helpers/consensus.hpp"
#include "chainserver/state/state.hpp"
#include "chainserver/state/transactions/block_applier.hpp"
#include "communication/create_payment.hpp"
#include "db/chain_db.hpp"
#include "general/is_testnet.hpp"
#include "global/globals.hpp"
#include "nlohmann/json.hpp"
#include <chrono>
#include <filesystem>
#include <iostream>
#include <memory>
#include <stdexcept>

using json = nlohmann::json;
static void check(bool value, const std::string& message)
{
    if (!value) throw std::runtime_error(message);
}
static Funds funds(uint64_t n) { return Funds::from_value_throw(n); }
static chainserver::TransactionIds txids(std::initializer_list<TransactionId> values)
{
    chainserver::TransactionIds result;
    result.insert(values.begin(), values.end());
    return result;
}

struct TemporaryDirectory {
    std::filesystem::path path = std::filesystem::temp_directory_path()
        / ("warthog-mempool-" + std::to_string(std::chrono::high_resolution_clock::now().time_since_epoch().count()));
    TemporaryDirectory() { check(std::filesystem::create_directory(path), "create private test directory"); }
    ~TemporaryDirectory() { std::error_code error; std::filesystem::remove_all(path, error); }
};

static std::vector<Batch> batches(const std::vector<Header>& headers)
{
    std::vector<Batch> result;
    Batch batch;
    for (auto& header : headers) {
        batch.append(header);
        if (batch.complete()) {
            result.push_back(std::move(batch));
            batch = Batch();
        }
    }
    if (batch.size()) result.push_back(std::move(batch));
    return result;
}

struct DatabaseFixture {
    ChainDB db;
    BatchRegistry& registry;
    // Public fixture keys only; never connect these funded databases to peers.
    PrivKey signer { "0000000000000000000000000000000000000000000000000000000000000001" };
    PrivKey recipient { "0000000000000000000000000000000000000000000000000000000000000002" };
    PrivKey miner { "0000000000000000000000000000000000000000000000000000000000000003" };
    std::vector<Header> headers;

    DatabaseFixture(BatchRegistry& registry, unsigned height,
        const std::string& path = "", const std::string& journal = "delete")
        : db(path, journal), registry(registry)
    {
        auto transaction = db.transaction();
        db.insertStateEntry(signer.pubkey().address(), funds(100), AccountId(1));
        db.insertStateEntry(recipient.pubkey().address(), Funds::zero(), AccountId(2));
        db.insertStateEntry(miner.pubkey().address(), Funds::zero(), AccountId(3));
        // Seed storage, not a consensus-valid historical chain. Empty structural
        // bodies suffice to initialize the confirmed nonce cache for these tests.
        for (unsigned h = 1; h <= height; ++h) {
            const NonzeroHeight nh(h);
            BodyContainer body(std::vector<uint8_t>(28, 0));
            auto header = make_header(headers.empty() ? Hash::genesis() : headers.back().hash(), body, nh, h);
            Block block { nh, header, std::move(body), {} };
            auto [id, inserted] = db.insert_protect(block);
            check(inserted, "seed block identity");
            db.insert_consensus(nh, id, HistoryId(1), AccountId(h == 1 ? 1 : 4));
            headers.push_back(header);
        }
        ExtendableHeaderchain chain(batches(headers), registry);
        db.set_consensus_work(chain.total_work());
        transaction.commit();
    }

    static Header make_header(Hash previous, const BodyContainer& body, NonzeroHeight height, uint32_t nonce)
    {
        HeaderGenerator generator(previous, body.view(height), TargetV2::genesis_testnet(),
            1700000000 + height.value() * 20, height);
        return generator.serialize(nonce);
    }
    Hash pin_hash(unsigned pin) const { return pin == 0 ? Hash::genesis() : headers.at(pin - 1).hash(); }
    PaymentCreateMessage payment(unsigned nonce, unsigned fee, unsigned amount, unsigned pin = 0) const
    {
        return { PinHeight(Height(pin)), pin_hash(pin), signer,
            CompactUInt::compact(funds(fee)), recipient.pubkey().address(), funds(amount), NonceId(nonce) };
    }
    TransferTxExchangeMessage transfer(const PaymentCreateMessage& payment) const
    {
        return { AccountId(1), payment };
    }
    Block make_block(NonzeroHeight height, Hash previous,
        const std::vector<TransferTxExchangeMessage>& transfers, unsigned nonce = 100000) const
    {
        auto body = generate_body(db, height, miner.pubkey().address(), transfers);
        auto header = make_header(previous, body, height, nonce + height.value());
        return { height, header, std::move(body), {} };
    }
    void apply_body(const Block& block)
    {
        ExtendableHeaderchain chain(batches(headers), registry);
        auto ids = db.fetch_tx_ids(chain.length());
        auto transaction = db.transaction();
        auto [id, inserted] = db.insert_protect(block);
        check(inserted, "control block insertion");
        chainserver::BlockApplier applier(db, chain, ids, true);
        (void)applier.apply_block(block.body_view(), block.header, block.height, id);
        chain.append({ block.header, block.header.hash() }, registry);
        db.set_consensus_work(chain.total_work());
        transaction.commit();
        headers.push_back(block.header);
    }
};

// Compare canonical application results, excluding physical row IDs, orphan
// retention schedules and local mempool policy. This includes history and undo.
static json ledger_snapshot(ChainDB& db, Height length)
{
    json result;
    for (unsigned id = 1; id <= 3; ++id) {
        const auto account = db.fetch_account(AccountId(uint64_t(id)));
        result["accounts"].push_back({ serialize_hex(account.address), account.funds.E8() });
    }
    for (auto id : db.consensus_block_ids(Height(1), length + 1)) {
        const auto block = db.get_block(id);
        const auto undo = db.get_block_undo(id);
        check(block.has_value() && undo.has_value(), "snapshot canonical block");
        result["blocks"].push_back({ block->height.value(), serialize_hex(block->header),
            serialize_hex(block->body.data()), serialize_hex(std::get<2>(*undo)) });
    }
    for (const auto& [hash, data] : db.lookupHistoryRange(HistoryId(1), db.next_history_id()))
        result["history"].push_back({ serialize_hex(hash), serialize_hex(data) });
    result["next_history"] = db.next_history_id().value();
    result["next_account"] = db.next_state_id().value();
    return result;
}

static void same_pool(const mempool::Mempool& master, const mempool::Mempool& mirror, NonzeroHeight next)
{
    std::vector<Hash> masterHashes, mirrorHashes;
    const auto a = master.get_payments(10000, next, &masterHashes);
    const auto b = mirror.get_payments(10000, next, &mirrorHashes);
    check(master.size() == mirror.size() && a.size() == b.size() && masterHashes == mirrorHashes,
        "master/follower transaction and fee order");
    for (size_t i = 0; i < a.size(); ++i) {
        check(a[i].txid == b[i].txid && mirror[masterHashes[i]].has_value(), "mirror ID/hash indexes");
    }
}

static void apply_template(ChainDB& db, const Headerchain& headers,
    const chainserver::TransactionIds& ids, const Block& block, size_t transfers)
{
    const auto before = ledger_snapshot(db, headers.length());
    {
        auto transaction = db.transaction();
        const auto [id, inserted] = db.insert_protect(block);
        check(inserted, "fresh template identity");
        check(block.header.merkleroot() == block.body_view().merkle_root(block.height), "template root");
        chainserver::BlockApplier applier(db, headers, ids, false);
        const auto result = applier.apply_block(block.body_view(), block.header, block.height, id);
        check(result.transfers.size() == transfers, "template transfers pass real body/signature checks");
        // Leave both the committed chain and test balances unchanged.
    }
    check(ledger_snapshot(db, headers.length()) == before, "template validation rollback");
}

struct PoolFixture : DatabaseFixture {
    chainserver::Chainstate state;
    mempool::Mempool mirror { false };
    PoolFixture(BatchRegistry& registry, unsigned height)
        : DatabaseFixture(registry, height), state(db, registry) {}
    void sync()
    {
        mirror.apply_log(state.pop_mempool_log());
        same_pool(state.mempool(), mirror, (state.length() + 1).nonzero_assert());
    }
    void admit(const PaymentCreateMessage& payment)
    {
        (void)state.insert_tx(payment);
        sync();
    }
    void expect(const std::vector<PaymentCreateMessage>& payments)
    {
        sync();
        check(state.mempool().size() == payments.size(), "expected pool size");
        for (auto& payment : payments)
            check(state.mempool()[transfer(payment).txid].has_value(), "expected transaction retained");
        const auto next = (state.length() + 1).nonzero_assert();
        const auto selected = state.mempool().get_payments(400, next);
        const auto mirrored = mirror.get_payments(400, next);
        const auto body = generate_body(db, next, miner.pubkey().address(), selected);
        check(body.data() == generate_body(db, next, miner.pubkey().address(), mirrored).data(),
            "master/follower mining bodies");
        Block block { next, make_header(state.final_hash(), body, next, 999999), body, {} };
        apply_template(db, state.headers(), state.txids(), block, payments.size());
    }
    void append(bool single, const chainserver::TransactionIds& confirmed, Funds finalBalance)
    {
        auto nextHeaders = headers;
        const auto next = (state.length() + 1).nonzero_assert();
        BodyContainer body(std::vector<uint8_t>(28, 0));
        auto header = make_header(headers.back().hash(), body, next, next.value());
        nextHeaders.push_back(header);
        // Supply the final ledger balance that the already-validated block would
        // have committed; this fixture isolates local reservation reconciliation.
        auto transaction = db.transaction();
        db.set_balance(AccountId(1), finalBalance);
        const auto [id, inserted] = db.insert_protect({ next, header, std::move(body), {} });
        check(inserted, "append fixture identity");
        db.insert_consensus(next, id, HistoryId(1), AccountId(4));
        transaction.commit();
        auto ids = confirmed;
        if (single) {
            std::optional<SignedSnapshot> snapshot;
            (void)state.append(chainserver::Chainstate::AppendSingle {
                { { AccountId(1), finalBalance } }, snapshot, { header, header.hash() },
                std::move(ids), HistoryId(1), AccountId(4) });
        } else {
            chainserver::AppendBlocksResult result { { { AccountId(1), finalBalance } },
                { HistoryId(1) }, { AccountId(4) }, std::move(ids) };
            (void)state.append(chainserver::Chainstate::AppendMulti {
                ExtendableHeaderchain(batches(nextHeaders), registry), std::move(result) });
        }
        check(state.txids() == confirmed, "append confirmed replay-protection IDs unchanged");
        headers = std::move(nextHeaders);
    }
    void fork(unsigned common, unsigned newLength, std::vector<TransferTxExchangeMessage> restored,
        chainserver::TransactionIds confirmed, Funds finalBalance)
    {
        auto nextHeaders = headers;
        nextHeaders.resize(common);
        for (unsigned h = common + 1; h <= newLength; ++h) {
            BodyContainer body(std::vector<uint8_t>(28, 0));
            nextHeaders.push_back(make_header(nextHeaders.back().hash(), body, NonzeroHeight(h), 100000 + h));
        }
        check(nextHeaders.at(common) != headers.at(common), "fork diverges after common prefix");
        auto transaction = db.transaction();
        auto deletionKey = db.delete_consensus_from(NonzeroHeight(common + 1));
        for (unsigned h = common + 1; h <= newLength; ++h) {
            Block block { NonzeroHeight(h), nextHeaders[h - 1], BodyContainer(std::vector<uint8_t>(28, 0)), {} };
            auto [id, inserted] = db.insert_protect(block);
            check(inserted, "fork fixture identity");
            db.insert_consensus(block.height, id, HistoryId(1), AccountId(4));
        }
        db.set_balance(AccountId(1), finalBalance);
        transaction.commit();
        chainserver::RollbackResult rollback { Height(common), std::move(restored), {}, {}, deletionKey };
        chainserver::AppendBlocksResult result { { { AccountId(1), finalBalance } },
            std::vector<HistoryId>(newLength - common, HistoryId(1)),
            std::vector<AccountId>(newLength - common, AccountId(4)), confirmed };
        const auto descriptor = state.descriptor();
        state.fork({ ExtendableHeaderchain(batches(nextHeaders), registry), std::move(rollback), std::move(result) });
        check(state.descriptor() == descriptor + 1 && state.length() == newLength, "fork descriptor/height");
        confirmed.prune(Height(newLength));
        check(state.txids() == confirmed, "fork confirmed replay-protection IDs unchanged");
        headers = std::move(nextHeaders);
    }
};

static void append_regressions(BatchRegistry& registry, bool single)
{
    {
        PoolFixture f(registry, 2);
        const auto confirmed = f.payment(1, 10, 50); // spend 60
        const auto pending = f.payment(2, 2, 18); // spend 20
        const auto pending2 = f.payment(3, 4, 16); // spend 20
        f.admit(confirmed); f.admit(pending); f.admit(pending2);
        f.append(single, txids({ f.transfer(confirmed).txid }), funds(40));
        f.expect({ pending, pending2 });
        try {
            (void)f.state.insert_tx(f.payment(90, 2, 1));
            throw std::runtime_error("full remaining balance accepted another spend");
        } catch (Error error) { check(error.e == EBALANCE, "remaining reservation accounting"); }
        f.expect({ pending, pending2 });
    }
    {
        PoolFixture f(registry, 2);
        const auto costly = f.payment(1, 2, 38); // lower-fee spend 40
        const auto affordable = f.payment(2, 10, 10); // spend 20
        f.admit(costly); f.admit(affordable);
        f.append(single, {}, funds(40)); // debit came from outside this pool
        f.expect({ affordable });
        const auto exact = f.payment(3, 4, 16);
        f.admit(exact);
        f.expect({ affordable, exact });
    }
}

static void fork_expiry_regressions(BatchRegistry& registry)
{
    {
        PoolFixture f(registry, 8190);
        const auto expired = f.payment(1, 2, 10, 0);
        const auto active = f.payment(2, 2, 10, 96);
        const auto invalidated = f.payment(3, 2, 10, 8160);
        const auto included = f.payment(4, 2, 10, 128);
        const auto restoredExpired = f.payment(5, 2, 10, 32);
        const auto restoredActive = f.payment(6, 2, 10, 192);
        f.admit(expired); f.admit(active); f.admit(invalidated); f.admit(included);
        f.fork(8149, 8256, { f.transfer(restoredExpired), f.transfer(restoredActive), f.transfer(included) },
            txids({ f.transfer(included).txid }), funds(88));
        const auto log = f.state.pop_mempool_log();
        for (auto& action : log) {
            if (auto put = std::get_if<mempool::Put>(&action))
                check(put->entry.first != f.transfer(restoredExpired).txid, "expired rollback transaction never published");
        }
        f.mirror.apply_log(log);
        f.expect({ active, restoredActive });
    }
    {
        PoolFixture f(registry, 8190);
        const auto atZero = f.payment(1, 2, 10);
        f.admit(atZero);
        f.fork(8149, 8190, {}, {}, funds(100));
        f.expect({ atZero }); // immediately before the next admission-window step
    }
    {
        PoolFixture f(registry, 8190);
        const auto oldPin = f.payment(1, 2, 10);
        const auto boundary = f.payment(2, 2, 10, 32);
        f.admit(oldPin); f.admit(boundary);
        f.fork(8149, 8191, {}, {}, funds(100));
        f.expect({ boundary }); // reuse the existing admission policy, not new block rules
    }
    {
        PoolFixture f(registry, 8256);
        const auto active = f.payment(1, 2, 10, 96);
        const auto invalidated = f.payment(2, 2, 10, 8192);
        const auto restored = f.payment(3, 2, 10, 32);
        f.admit(active); f.admit(invalidated);
        // Reconciliation for a shorter replacement is tested independently of
        // fork choice; these unmined headers are not claimed to win by work.
        f.fork(8179, 8190, { f.transfer(restored) }, {}, funds(100));
        f.expect({ active, restored });
    }
}

static void fork_balance_regressions(BatchRegistry& registry)
{
    PoolFixture f(registry, 3);
    const auto confirmed = f.payment(1, 10, 50);
    const auto pending = f.payment(2, 2, 18);
    const auto restored = f.payment(3, 4, 4);
    f.admit(confirmed); f.admit(pending);
    f.fork(1, 4, { f.transfer(restored), f.transfer(confirmed) }, txids({ f.transfer(confirmed).txid }), funds(40));
    f.expect({ pending, restored });
    // The restored transaction reserves eight more units, leaving twelve.
    const auto exact = f.payment(4, 2, 10);
    f.admit(exact);
    f.expect({ pending, restored, exact });
}

enum class Failure { Balance, Signature, Duplicate };
static void partial_stage_case(BatchRegistry& registry, const std::string& journal,
    unsigned successes, unsigned originalLength, Failure failure)
{
    TemporaryDirectory directory;
    DatabaseFixture f(registry, 1, (directory.path / "subject.db").string(), journal);
    for (unsigned h = 2; h <= originalLength; ++h)
        f.apply_body(f.make_block(NonzeroHeight(h), f.headers.back().hash(), {}, 200000));
    chainserver::State state(f.db, registry, {});
    mempool::Mempool mirror(false);
    const auto big = f.payment(99, 2, 78); // reserves 80
    const auto small = f.payment(100, 4, 1); // reserves 5
    for (auto& payment : { big, small }) {
        auto [log, hash] = state.append_gentx(payment);
        (void)hash;
        mirror.apply_log(log);
    }
    const auto original = ledger_snapshot(f.db, state.chainlength());
    const auto originalWork = f.db.get_consensus_work();
    const auto originalHeaderChain = state.get_headers();

    std::vector<Block> branch;
    std::vector<Header> branchHeaders { f.headers[0] };
    const unsigned invalidHeight = 2 + successes;
    // A trailing block ensures a failed/nonwinning prefix is actually applied
    // and rolled back, rather than only being stored as a lower-work stage.
    const unsigned lastStored = std::max(invalidHeight, originalLength + 1);
    for (unsigned h = 2; h <= lastStored + 1; ++h) {
        auto payment = f.payment(10 + h - 2, h == 2 ? 10 : 2, h == 2 ? 50 : 4);
        if (h == invalidHeight) {
            if (failure == Failure::Balance) payment = f.payment(500, 10, 100);
            if (failure == Failure::Signature)
                payment.signature = f.miner.sign(payment.tx_hash(Hash::genesis()));
            if (failure == Failure::Duplicate) payment = f.payment(10, 2, 4);
        }
        auto block = f.make_block(NonzeroHeight(h), branchHeaders.back().hash(), { f.transfer(payment) });
        if (h == lastStored + 1) {
            HeaderGenerator generator(branchHeaders.back().hash(), block.body_view(), TargetV2::genesis_testnet(),
                block.header.timestamp(), block.height);
            generator.version = 0; // deterministic rejection of the trigger header
            block.header = generator.serialize(h);
        }
        branchHeaders.push_back(block.header);
        branch.push_back(std::move(block));
    }
    {
        auto transaction = f.db.transaction();
        for (size_t i = 0; i + 1 < branch.size(); ++i) {
            const auto [id, inserted] = f.db.insert_protect(branch[i]);
            (void)id;
            check(inserted, "store synthetic stage fixture");
        }
        transaction.commit();
    }
    auto stagedHeaders = branchHeaders;
    stagedHeaders.pop_back();
    (void)state.set_stage(Headerchain(HeaderchainSkeleton({}, batches(stagedHeaders).front())));
    Headerchain all(HeaderchainSkeleton({}, batches(branchHeaders).front()));
    auto [result, update] = state.add_stage({ branch.back() }, all);
    const auto expectedError = failure == Failure::Balance ? EBALANCE
        : failure == Failure::Signature ? ECORRUPTEDSIG : ENONCE;
    check(result.ce.e == expectedError && result.ce.height() == invalidHeight,
        "body rejection code/height preserved");
    const bool winning = 1 + successes > originalLength;
    check(update.has_value() == winning, "partial-prefix fork-choice decision unchanged");
    if (winning) {
        mirror.apply_log(update->mempoolUpdate);
        check(state.chainlength() == 1 + successes, "only valid prefix committed");
        auto entries = state.api_get_mempool(100);
        check(entries.entries.size() == 1 && state.get_mempool_tx(f.transfer(small).txid).has_value(),
            "successful-prefix balances evict unaffordable transaction and retain affordable one");
        DatabaseFixture control(registry, 1, (directory.path / "control.db").string(), journal);
        for (unsigned i = 0; i < successes; ++i) control.apply_body(branch[i]);
        check(ledger_snapshot(f.db, state.chainlength()) == ledger_snapshot(control.db, Height(1 + successes)),
            "partial application ledger/history/undo equals valid-prefix control");
        check(f.db.get_consensus_work() == control.db.get_consensus_work(), "prefix work equals control");
    } else {
        check(state.chainlength() == originalLength && ledger_snapshot(f.db, state.chainlength()) == original,
            "nonwinning/empty prefix rolls back ledger/history/undo");
        check(f.db.get_consensus_work() == originalWork
                && state.get_headers().total_work() == originalHeaderChain.total_work(),
            "nonwinning prefix retains consensus work");
        check(state.api_get_mempool(100).entries.size() == 2, "rejected prefix preserves pending transactions");
    }
    const auto next = (state.chainlength() + 1).nonzero_assert();
    auto task = state.mining_task(f.miner.pubkey().address());
    check(task.has_value(), "mining continues after partial failure");
    const auto expected = winning ? 1u : 2u;
    check(task->block.body.data() == generate_body(f.db, next, f.miner.pubkey().address(), mirror.get_payments(400, next)).data(),
        "partial-stage mirror produces the actual mining template");
    auto ids = f.db.fetch_tx_ids(state.chainlength());
    apply_template(f.db, state.get_headers(), ids, task->block, expected);
}

static void partial_stage_regressions(BatchRegistry& registry)
{
    for (const std::string journal : { "delete", "wal" }) {
        partial_stage_case(registry, journal, 1, 1, Failure::Balance);
        partial_stage_case(registry, journal, 2, 1, Failure::Signature);
        partial_stage_case(registry, journal, 2, 1, Failure::Duplicate);
        partial_stage_case(registry, journal, 2, 2, Failure::Balance); // fork with a winning valid prefix
        partial_stage_case(registry, journal, 1, 3, Failure::Balance); // nonwinning fork prefix
        partial_stage_case(registry, journal, 0, 1, Failure::Balance); // failure before any valid block
    }
}

int main(int argc, char** argv) try {
    check(argc == 2, "usage: mempool_reconciliation append-single|append-multi|fork-expiry|fork-balances|partial-stage");
    enable_testnet();
    ECC_Start();
    struct StopECC { ~StopECC() { ECC_Stop(); } } stopECC;
    set_config().node.minMempoolFee = CompactUInt::smallest();
    BatchRegistry registry;
    HTTPEndpoint endpoint(EndpointAddress(IPv4(0x7f000001), 0));
    global_init(&registry, nullptr, nullptr, nullptr, nullptr, &endpoint);
    const std::string group(argv[1]);
    if (group == "append-single") append_regressions(registry, true);
    else if (group == "append-multi") append_regressions(registry, false);
    else if (group == "fork-expiry") fork_expiry_regressions(registry);
    else if (group == "fork-balances") fork_balance_regressions(registry);
    else if (group == "partial-stage") partial_stage_regressions(registry);
    else throw std::runtime_error("unknown regression group");
    std::cout << "MEMPOOL_RECONCILIATION_OK " << group << '\n';
    return 0;
} catch (const std::exception& error) {
    std::cerr << "MEMPOOL_RECONCILIATION_FAILED " << error.what() << '\n'; return 1;
} catch (Error error) {
    std::cerr << "MEMPOOL_RECONCILIATION_FAILED " << error.strerror() << '\n'; return 1;
}
