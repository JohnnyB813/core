
include_wh=[include_trezorcrypto,include_directories('./src'),include_directories('.')]
src_wh=[
    src_trezorcrypto,
  files(
  [
    './platformassert.cpp',
    './src/block/body/container.cpp',
    './src/block/body/nonce.cpp',
    './src/block/body/transaction_id.cpp',
    './src/block/body/view.cpp',
    './src/block/chain/height.cpp',
    './src/block/chain/worksum.cpp',
    './src/block/header/generator.cpp',
    './src/block/header/header.cpp',
    './src/block/header/view.cpp',
    './src/block/header/pow_version.cpp',
    './src/communication/create_payment.cpp',
    './src/crypto/address.cpp',
    './src/crypto/crypto.cpp',
    './src/crypto/hash.cpp',
    './src/crypto/verushash/verus_clhash_port.cpp',
    './src/crypto/verushash/verushash.cpp',
    './src/general/compact_uint.cpp',
    './src/general/errors.cpp',
    './src/general/is_testnet.cpp',
    './src/general/funds.cpp',
    './src/general/hex.cpp',
    './src/general/with_uint64.cpp',
  ]
  )]


versions = meson.project_version().split('.')
conf_version = configuration_data()
conf_version.set('VERSION_MAJOR', versions.get(0))
conf_version.set('VERSION_MINOR', versions.get(1))
conf_version.set('VERSION_PATCH', versions.get(2))
configure_file(input : './src/version.hpp.in',
               output : 'version.hpp',
               configuration : conf_version)


commit = run_command('sh', '-c', 'printf %s "${WARTHOG_COMMIT:-}"',
  check : false).stdout().strip()
conf_commit = configuration_data()
conf_commit.set('GIT_COMMIT_INFO', commit == '' ? 'unknown' : commit)
configure_file(input : './src/commit_info.hpp.in',
               output : 'commit_info.hpp',
               configuration : conf_commit)
