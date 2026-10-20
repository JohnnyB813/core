src= [
  './api/http/endpoint.cpp',
  './api/http/json.cpp',
  './api/http/parse.cpp',
  './api/interface.cpp',
  './api/stratum/stratum_server.cpp',
  './api/types/all.cpp',
  './asyncio/conman.cpp',
  './asyncio/connection.cpp',
  './asyncio/helpers/per_ip_counter.cpp',
  './block/body/generator.cpp',
  './block/body/primitives.cpp',
  './block/chain/consensus_headers.cpp',
  './block/chain/fork_range.cpp',
  './block/chain/header_chain.cpp',
  './block/chain/history/history.cpp',
  './block/chain/pin.cpp',
  './block/chain/range.cpp',
  './block/chain/signed_snapshot.cpp',
  './block/chain/state.cpp',
  './block/header/batch.cpp',
  './block/header/shared_batch.cpp',
  './block/header/timestamprule.cpp',
  './chainserver/account_cache.cpp',
  './chainserver/server.cpp',
  './chainserver/mining_subscription.cpp',
  './chainserver/state/helpers/consensus.cpp',
  './chainserver/state/helpers/past_chains.cpp',
  './chainserver/state/state.cpp',
  './chainserver/state/transactions/apply_stage.cpp',
  './chainserver/state/transactions/block_applier.cpp',
  './cmdline/cmdline.cpp',
  './communication/buffers/recvbuffer.cpp',
  './communication/buffers/sndbuffer.cpp',
  './communication/messages.cpp',
  './config/config.cpp',
  './db/chain_db.cpp',
  './db/peer_db.cpp',
  './eventloop/address_manager/address_manager.cpp',
  './eventloop/address_manager/flat_address_set.cpp',
  './eventloop/chain_cache.cpp',
  './eventloop/eventloop.cpp',
  './eventloop/peer_chain.cpp',
  './eventloop/sync/block_download/attorney.cpp',
  './eventloop/sync/block_download/block_download.cpp',
  './eventloop/sync/block_download/focus.cpp',
  './eventloop/sync/block_download/forks.cpp',
  './eventloop/sync/block_download/connection_data.cpp',
  './eventloop/sync/block_download/stage_state.cpp',
  './eventloop/sync/header_download/connection_data.cpp',
  './eventloop/sync/header_download/header_download.cpp',
  './eventloop/sync/header_download/probe_balanced.cpp',
  './eventloop/timer.cpp',
  './eventloop/types/chainstate.cpp',
  './eventloop/types/conndata.cpp',
  './general/tcp_util.cpp',
  './general/latency.cpp',
  './global/globals.cpp',
  './mempool/mempool.cpp',
  './mempool/txmap.cpp',
  './mempool/subscription.cpp',
  './peerserver/ban_cache.cpp',
  './peerserver/peerserver.cpp',
]

include_thirdparty=[include_trezorcrypto,include_wh,include_secp256k1,include_sqlitecpp,include_usockets,include_uwebsockets,include_json,include_tomlplusplus, include_tl]
lib_thirdparty=[libsecp256k1, libusockets]
node_source_files = files(src) + src_sqlitecpp + src_wh
node_runtime = executable('wart-node', vcs_dep, [node_source_files,'./main.cpp'],
  include_directories:['./' ,include_thirdparty],
  link_with: lib_thirdparty,
  dependencies: [sqlite3_dep,libuv_dep,uvw_dep,spdlog_dep],
  install : true)

mempool_replacement = executable('mempool_replacement', vcs_dep, '../test/mempool_replacement.cpp',
  objects: node_runtime.extract_objects(node_source_files),
  include_directories: ['./', include_thirdparty],
  link_with: lib_thirdparty,
  dependencies: [sqlite3_dep, libuv_dep, uvw_dep, spdlog_dep])
test('Mempool replacement accounting', mempool_replacement)

admission_cpp_args = []
admission_link_args = []
if host_machine.system() == 'linux'
  admission_cpp_args += ['-DCOUNT_SIGNATURE_RECOVERIES']
  admission_link_args += ['-Wl,--wrap=secp256k1_ecdsa_recover']
endif
mempool_admission = executable('mempool_admission', vcs_dep, '../test/mempool_admission.cpp',
  objects: node_runtime.extract_objects(node_source_files),
  include_directories: ['./', include_thirdparty],
  link_with: lib_thirdparty,
  cpp_args: admission_cpp_args,
  link_args: admission_link_args,
  dependencies: [sqlite3_dep, libuv_dep, uvw_dep, spdlog_dep])
test('Mempool admission signatures', mempool_admission,
  args: files('../test/fixtures/genesis-mainnet.json'))

stratum_preparation = executable('stratum_preparation', vcs_dep, '../test/stratum_preparation.cpp',
  objects: node_runtime.extract_objects(node_source_files),
  include_directories: ['./', include_thirdparty],
  link_with: lib_thirdparty,
  dependencies: [sqlite3_dep, libuv_dep, uvw_dep, spdlog_dep])
test('Stratum work preparation', stratum_preparation)

db_maintenance = executable('db_maintenance', vcs_dep, '../test/db_maintenance.cpp',
  objects: node_runtime.extract_objects(node_source_files),
  include_directories: ['./', include_thirdparty],
  link_with: lib_thirdparty,
  dependencies: [sqlite3_dep, libuv_dep, uvw_dep, spdlog_dep])
test('Database maintenance retention and retry', db_maintenance)

block_lookup = executable('block_lookup', vcs_dep, '../test/block_lookup.cpp',
  objects: node_runtime.extract_objects(node_source_files),
  include_directories: ['./', include_thirdparty],
  link_with: lib_thirdparty,
  dependencies: [sqlite3_dep, libuv_dep, uvw_dep, spdlog_dep])
test('Block lookup height and identity', block_lookup,
  args: files('../test/fixtures/genesis-mainnet.json'))

if get_option('performance-tools')
  executable('block_application_profile', vcs_dep, '../test/block_application_profile.cpp',
    objects: node_runtime.extract_objects(node_source_files),
    include_directories: ['./', include_thirdparty],
    link_with: lib_thirdparty,
    cpp_args: admission_cpp_args,
    link_args: admission_link_args,
    dependencies: [sqlite3_dep, libuv_dep, uvw_dep, spdlog_dep])
  executable('stratum_fanout', vcs_dep, '../test/stratum_fanout.cpp',
    objects: node_runtime.extract_objects(node_source_files),
    include_directories: ['./', include_thirdparty],
    link_with: lib_thirdparty,
    dependencies: [sqlite3_dep, libuv_dep, uvw_dep, spdlog_dep])
  node_replay = executable('node_replay', vcs_dep, '../test/node_replay.cpp',
    objects: node_runtime.extract_objects(node_source_files),
    include_directories: ['./', include_thirdparty],
    link_with: lib_thirdparty,
    dependencies: [sqlite3_dep, libuv_dep, uvw_dep, spdlog_dep])
  old_sqlite_dep = subproject('sqlite3-baseline', default_options: ['warning_level=0', 'werror=false']).get_variable('sqlite3_dep')
  executable('node_replay_old_sqlite', vcs_dep, '../test/node_replay.cpp',
    objects: node_runtime.extract_objects(node_source_files),
    include_directories: ['./', include_thirdparty],
    link_with: lib_thirdparty,
    dependencies: [old_sqlite_dep, libuv_dep, uvw_dep, spdlog_dep])
endif

