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

local_correctness = executable('local_correctness', vcs_dep, '../test/local_correctness.cpp',
  objects: node_runtime.extract_objects(node_source_files),
  include_directories: ['./', include_thirdparty], link_with: lib_thirdparty,
  dependencies: [sqlite3_dep, libuv_dep, uvw_dep, spdlog_dep])
foreach group : ['addresses', 'janushash']
  test('Local correctness ' + group, local_correctness, args: [group])
endforeach

worker_cpp_args = []
worker_link_args = []
if host_machine.system() == 'linux'
  worker_cpp_args = ['-DWORKER_JOIN_BARRIER']
  worker_link_args = ['-Wl,--wrap=pthread_join']
endif
chain_worker = executable('chain_worker', vcs_dep, '../test/chain_worker.cpp',
  objects: node_runtime.extract_objects(node_source_files),
  include_directories: ['./', include_thirdparty], link_with: lib_thirdparty,
  cpp_args: worker_cpp_args, link_args: worker_link_args,
  dependencies: [sqlite3_dep, libuv_dep, uvw_dep, spdlog_dep])
test('Chain worker concurrency and shutdown', chain_worker, timeout: 120,
  env: {'HOME': meson.current_build_dir() / 'worker-home'})

mempool_reconciliation = executable('mempool_reconciliation', vcs_dep, '../test/mempool_reconciliation.cpp',
  objects: node_runtime.extract_objects(node_source_files),
  include_directories: ['./', include_thirdparty],
  link_with: lib_thirdparty,
  dependencies: [sqlite3_dep, libuv_dep, uvw_dep, spdlog_dep])
foreach group : ['append-single', 'append-multi', 'fork-expiry', 'fork-balances', 'partial-stage']
  test('Mempool reconciliation ' + group, mempool_reconciliation, args: [group], timeout: 120,
    env: {'HOME': meson.current_build_dir() / 'reconciliation-home' / group})
endforeach

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

mempool_api_snapshot = executable('mempool_api_snapshot', vcs_dep, '../test/mempool_api_snapshot.cpp',
  objects: node_runtime.extract_objects(node_source_files),
  include_directories: ['./', include_thirdparty], link_with: lib_thirdparty,
  cpp_args: admission_cpp_args, link_args: admission_link_args,
  dependencies: [sqlite3_dep, libuv_dep, uvw_dep, spdlog_dep])
test('Mempool API snapshot ownership and senders', mempool_api_snapshot,
  args: files('../test/fixtures/genesis-mainnet.json'))

websocket_cpp_args = []
websocket_link_args = []
if host_machine.system() == 'linux' and meson.get_compiler('cpp').get_id() == 'gcc'
  # These two return-value ABI tags are specific to GCC/libstdc++.
  websocket_cpp_args = ['-DCOUNT_WEBSOCKET_FORMATS']
  websocket_link_args = ['-Wl,--wrap=_ZN7jsonmsg7to_jsonB5cxx11ERKN3API5BlockE',
    '-Wl,--wrap=_ZN7jsonmsg7to_jsonB5cxx11ERKN3API8RollbackE']
endif
websocket_probe = executable('websocket_probe', vcs_dep, '../test/websocket_probe.cpp',
  objects: node_runtime.extract_objects(node_source_files),
  include_directories: ['./', include_thirdparty], link_with: lib_thirdparty,
  cpp_args: websocket_cpp_args, link_args: websocket_link_args,
  dependencies: [sqlite3_dep, libuv_dep, uvw_dep, spdlog_dep])
test_python = import('python').find_installation('python3', required: false)
if test_python.found()
  test('WebSocket subscribers and serialization', test_python,
    args: [files('../test/websocket_subscribers.py'), websocket_probe,
      files('../test/fixtures/genesis-mainnet.json')], timeout: 60)
  test('Public WebSocket event delivery', test_python,
    args: [files('../test/websocket_public.py'), websocket_probe,
      files('../test/fixtures/genesis-mainnet.json')], timeout: 60)
endif

stratum_preparation = executable('stratum_preparation', vcs_dep, '../test/stratum_preparation.cpp',
  objects: node_runtime.extract_objects(node_source_files),
  include_directories: ['./', include_thirdparty],
  link_with: lib_thirdparty,
  dependencies: [sqlite3_dep, libuv_dep, uvw_dep, spdlog_dep])
test('Stratum work preparation', stratum_preparation)

stratum_job_cache = executable('stratum_job_cache', vcs_dep, '../test/stratum_job_cache.cpp',
  objects: node_runtime.extract_objects(node_source_files),
  include_directories: ['./', include_thirdparty], link_with: lib_thirdparty,
  dependencies: [sqlite3_dep, libuv_dep, uvw_dep, spdlog_dep])
test('Stratum job cache', stratum_job_cache)

stratum_submission = executable('stratum_submission', vcs_dep, '../test/stratum_submission.cpp',
  objects: node_runtime.extract_objects(node_source_files),
  include_directories: ['./', include_thirdparty], link_with: lib_thirdparty,
  dependencies: [sqlite3_dep, libuv_dep, uvw_dep, spdlog_dep])
foreach network : ['mainnet', 'testnet']
  test('Stratum submission ' + network, stratum_submission, args: [network])
endforeach

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

foreach group : ['http_payment_parsing', 'header_verifier', 'hashrate_reporting', 'timer_handles']
  correctness = executable(group, vcs_dep, '../test/' + group + '.cpp',
    objects: node_runtime.extract_objects(node_source_files),
    include_directories: ['./', include_thirdparty], link_with: lib_thirdparty,
    dependencies: [sqlite3_dep, libuv_dep, uvw_dep, spdlog_dep])
  test('Mainnet correctness ' + group, correctness)
endforeach

if get_option('performance-tools')
  submit_profile_sources = []
  foreach source : src
    if source != './api/stratum/stratum_server.cpp'
      submit_profile_sources += files(source)
    endif
  endforeach
  executable('stratum_submission_profile', vcs_dep,
    ['./main.cpp', './api/stratum/stratum_server.cpp', '../test/stratum_submission_profile.cpp'],
    objects: node_runtime.extract_objects(submit_profile_sources + src_sqlitecpp + src_wh),
    include_directories: ['./', include_thirdparty], link_with: lib_thirdparty,
    cpp_args: ['-Dput_chain_append=profile_chain_append'],
    dependencies: [sqlite3_dep, libuv_dep, uvw_dep, spdlog_dep])
  executable('stratum_submit_fixture', vcs_dep, '../test/stratum_submit_fixture.cpp',
    objects: node_runtime.extract_objects(node_source_files),
    include_directories: ['./', include_thirdparty], link_with: lib_thirdparty,
    dependencies: [sqlite3_dep, libuv_dep, uvw_dep, spdlog_dep])
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

