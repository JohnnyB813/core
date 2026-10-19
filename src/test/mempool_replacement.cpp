#include "communication/create_payment.hpp"
#include "global/globals.hpp"
#include "mempool/mempool.hpp"
#include <iostream>
#include <stdexcept>

static void check(bool value, const char* message)
{
    if (!value)
        throw std::runtime_error(message);
}

int main()
{
    ECC_Start();
    struct StopECC {
        ~StopECC() { ECC_Stop(); }
    } stopECC;
    set_config().node.minMempoolFee = CompactUInt::smallest();
    const PrivKey signer;
    const AddressFunds account { signer.pubkey().address(), Funds::from_value_throw(100) };
    const Address recipient(std::array<uint8_t, 20> {});
    const auto pinHeight = PinHeight(Height(0));
    const auto pinHash = Hash::genesis();
    const TransactionHeight txHeight(pinHeight, AccountHeight(1));
    auto payment = [&](uint32_t nonce, uint64_t fee, uint64_t amount) {
        PaymentCreateMessage created(pinHeight, pinHash, signer,
            CompactUInt::compact(Funds::from_value_throw(fee)), recipient,
            Funds::from_value_throw(amount), NonceId(nonce));
        return TransferTxExchangeMessage(AccountId(1), created);
    };
    auto insert = [&](mempool::Mempool& pool, const auto& tx, const AddressFunds& balance) {
        return pool.insert_tx(tx, txHeight, tx.txhash(pinHash), balance);
    };
    auto present = [&](const mempool::Mempool& pool, const auto& tx) {
        return pool[tx.txhash(pinHash)].has_value();
    };
    const auto original = payment(1, 2, 88); // reserves 90
    const auto replacement = payment(1, 4, 88); // reserves 92

    {
        mempool::Mempool pool;
        check(insert(pool, original, account) == 0, "insert original");
        check(insert(pool, replacement, account) == 0, "replacement reuses original reservation");
        check(pool.size() == 1 && present(pool, replacement) && !present(pool, original),
            "replacement updates transaction/hash indexes");
        check(insert(pool, payment(2, 2, 7), account) == EBALANCE,
            "replacement retains its full balance reservation");
        mempool::Mempool follower(false);
        follower.apply_log(pool.pop_log());
        check(follower.size() == 1 && present(follower, replacement) && !present(follower, original),
            "eventloop mempool receives replacement log");
        check(insert(pool, original, account) == ENONCE, "lower-fee replacement is rejected");
        check(insert(pool, replacement, account) == ENONCE, "equal-fee replacement is rejected");
    }
    {
        mempool::Mempool pool;
        const AddressFunds small { account.address, Funds::from_value_throw(90) };
        check(insert(pool, original, small) == 0, "insert against exact balance");
        check(insert(pool, replacement, small) == EBALANCE, "unaffordable replacement is rejected");
        check(pool.size() == 1 && present(pool, original), "rejection preserves original");
    }
    {
        mempool::Mempool pool;
        const auto unrelated = payment(2, 2, 6); // reserves 8
        check(insert(pool, original, account) == 0 && insert(pool, unrelated, account) == 0,
            "insert unrelated low-fee transaction");
        check(insert(pool, replacement, account) == 0, "replacement fits with unrelated transaction");
        check(pool.size() == 2 && present(pool, unrelated), "unnecessary eviction is avoided");
        const auto larger = payment(1, 8, 92); // reserves 100
        check(insert(pool, larger, account) == 0, "replacement can evict lower-fee transaction");
        check(pool.size() == 1 && present(pool, larger) && !present(pool, unrelated),
            "necessary eviction updates all indexes");
    }
    {
        mempool::Mempool pool;
        const auto unrelated = payment(2, 4, 4); // reserves 8, fee equals replacement
        check(insert(pool, original, account) == 0 && insert(pool, unrelated, account) == 0,
            "insert unrelated equal-fee transaction");
        const auto tooLarge = payment(1, 4, 92); // reserves 96, only 92 available after replacement
        check(insert(pool, tooLarge, account) == EBALANCE, "equal-fee transaction cannot be evicted");
        check(pool.size() == 2 && present(pool, original) && present(pool, unrelated),
            "failed replacement preserves both transactions");
    }
    std::cout << "mempool replacement accounting passed with real signatures\n";
}
