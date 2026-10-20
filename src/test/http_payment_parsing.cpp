#include "api/http/parse.hpp"
#include "nlohmann/json.hpp"
#include <iostream>
#include <stdexcept>

using json = nlohmann::json;

static void check(bool value, const char* message)
{
    if (!value) throw std::runtime_error(message);
}

static PaymentCreateMessage parse(const json& request)
{
    const auto text = request.dump();
    return parse_payment_create(std::vector<uint8_t>(text.begin(), text.end()));
}

static void reject(const json& request, int32_t expected)
{
    try {
        parse(request);
    } catch (Error error) {
        check(error.e == expected, "payment parser returned the wrong fee error");
        return;
    }
    throw std::runtime_error("payment parser accepted an invalid fee");
}

int main() try
{
    // Only parsing is exercised here; signature verification belongs to admission.
    const json base {
        { "pinHeight", 0 }, { "nonceId", 7 }, { "feeE8", 2 }, { "amountE8", 10 },
        { "toAddr", Address(std::array<uint8_t, 20> {}).to_string() },
        { "signature65", std::string(130, '0') }
    };
    const auto numeric = parse(base);
    auto textFee = base;
    textFee.erase("feeE8");
    textFee["fee"] = "0.00000002";
    const auto text = parse(textFee);
    check(numeric.compactFee == CompactUInt::compact(Funds::from_value_throw(2)), "numeric fee changed");
    check(text.compactFee == numeric.compactFee && text.signature.to_string() == numeric.signature.to_string(),
        "equivalent fee encodings parsed differently");

    auto missing = base;
    missing.erase("feeE8");
    for (unsigned i = 0; i < 100; ++i)
        reject(missing, EBADFEE);

    auto both = base;
    both["fee"] = "0.00000002";
    reject(both, EBADFEE);
    for (const json value : { json(), json("bad"), json::array(), json::object(), json(uint64_t(-1)) }) {
        auto bad = base;
        bad["feeE8"] = value;
        reject(bad, EBADFEE);
    }
    auto invalidText = textFee;
    invalidText["fee"] = "bad";
    reject(invalidText, EINV_FUNDS);

    // Preserve the distinct error for a valid amount that cannot be encoded exactly.
    auto inexact = base;
    inexact["feeE8"] = 2049;
    check(CompactUInt::compact(Funds::from_value_throw(2049)).uncompact() != Funds::from_value_throw(2049),
        "inexact fee fixture became exact");
    reject(inexact, EINEXACTFEE);
    std::cout << "Payment parser: valid encodings and 108 fee rejections passed\n";
} catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
}
