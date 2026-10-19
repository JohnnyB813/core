e = executable('custom_float', vcs_dep, ['./custom_float.cpp'],
  include_directories:['./' ,include_thirdparty]
  )
test('Custom float operations',e)

stratum_job_cache = executable('stratum_job_cache', vcs_dep, ['./stratum_job_cache.cpp'],
  include_directories: ['../node', include_thirdparty],
  dependencies: [spdlog_dep])
test('Stratum job cache', stratum_job_cache)

