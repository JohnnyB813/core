e = executable('custom_float', vcs_dep, ['./custom_float.cpp'],
  include_directories:['./' ,include_thirdparty]
  )
test('Custom float operations',e)

latency_policy = executable('latency_policy', ['./latency_policy.cpp', '../node/general/latency.cpp'],
  include_directories: ['../node', include_thirdparty], dependencies: [spdlog_dep, libuv_dep])
test('Latency policy', latency_policy)

journal_modes = executable('journal_modes', ['./journal_modes.cpp', src_sqlitecpp],
  include_directories: ['../node', include_thirdparty], dependencies: [sqlite3_dep])
test('Durable journal modes', journal_modes)

sqlite_workload = executable('sqlite_workload', './sqlite_workload.cpp',
  dependencies: [sqlite3_dep])
test('SQLite write and sync fault recovery', sqlite_workload, timeout: 180)
if get_option('performance-tools')
  executable('sqlite_workload_old', './sqlite_workload.cpp', dependencies: [old_sqlite_dep])
endif

