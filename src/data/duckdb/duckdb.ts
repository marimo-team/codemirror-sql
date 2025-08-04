/* Copyright 2025 Marimo. All rights reserved. */
// Credit to https://github.com/sekuel/codemirror-sql-duckdb/blob/main/DuckDBDialect.js for the dialect spec

import { SQLDialect, type SQLDialectSpec } from "@codemirror/lang-sql";
import type { SqlKeywordInfo } from "../../sql/hover.js";

const otherFunctions =
  "percentile_cont row_number rank dense_rank rank_dense percent_rank cume_dist ntile lag lead first_value last_value nth_value";

const DuckDBDialectSpec: SQLDialectSpec = {
  charSetCasts: true,
  doubleQuotedStrings: false,
  unquotedBitLiterals: true,
  hashComments: false,
  spaceAfterDashes: false,
  specialVar: "@?",
  identifierQuotes: "`",
  keywords: `${otherFunctions} !__postfix !~~ !~~* % & && * ** + - ->> / // <-> << <=> <@ >> @ @> Calendar JSON TimeZone ^ ^@ abort abs absolute access access_mode acos acosh action add add_parquet_key admin after age aggregate alias all all_profiling_output allow_community_extensions allow_extensions_metadata_mismatch allow_persistent_secrets allow_unredacted_secrets allow_unsigned_extensions allowed_directories allowed_paths also alter always analyse analyze and anti any any_value apply approx_count_distinct approx_quantile approx_top_k arbitrary arg_max arg_max_null arg_min arg_min_null argmax argmin array array_agg array_aggr array_aggregate array_append array_apply array_cat array_concat array_contains array_cosine_distance array_cosine_similarity array_cross_product array_distance array_distinct array_dot_product array_extract array_filter array_grade_up array_has array_has_all array_has_any array_indexof array_inner_product array_intersect array_length array_negative_dot_product array_negative_inner_product array_pop_back array_pop_front array_position array_prepend array_push_back array_push_front array_reduce array_resize array_reverse array_reverse_sort array_select array_slice array_sort array_to_json array_to_string array_to_string_comma_default array_transform array_unique array_value array_where array_zip arrow_large_buffer_size arrow_lossless_conversion arrow_output_list_view arrow_output_version arrow_scan arrow_scan_dumb as asc ascii asin asinh asof asof_loop_join_threshold assertion assignment asymmetric at atan atan2 atanh attach attribute authorization autoinstall_extension_repository autoinstall_known_extensions autoload_known_extensions avg backward bar base64 before begin between bigint bin binary binary_as_string bit bit_and bit_count bit_length bit_or bit_position bit_xor bitstring bitstring_agg blob bool bool_and bool_or boolean both bpchar by bytea cache call called can_cast_implicitly cardinality cascade cascaded case cast cast_to_type catalog catalog_error_max_schemas cbrt ceil ceiling centuries century chain char char_length character character_length characteristics check checkpoint checkpoint_threshold chr class close cluster coalesce col_description collate collation collations column columns combine comment comments commit committed compression concat concat_ws concurrently configuration conflict connection constant_or_null constraint constraints contains content continue conversion copy copy_database corr cos cosh cost cot count count_if count_star countif covar_pop covar_samp create create_sort_key cross csv cube current current_catalog current_connection_id current_database current_date current_localtime current_localtimestamp current_query current_query_id current_role current_schema current_schemas current_setting current_transaction_id current_user currval cursor custom_extension_repository custom_profiling_settings custom_user_agent cycle damerau_levenshtein data database database_list database_size date date_add date_diff date_part date_sub date_trunc datediff datepart datesub datetime datetrunc day dayname dayofmonth dayofweek dayofyear days deallocate debug_asof_iejoin debug_checkpoint_abort debug_force_external debug_force_no_cross_product debug_skip_checkpoint_on_commit debug_verify_vector debug_window_mode dec decade decades decimal declare decode default default_block_size default_collation default_null_order default_order default_secret_storage defaults deferrable deferred definer degrees delete delimiter delimiters depends desc describe detach dictionary disable disable_checkpoint_on_shutdown disable_logging disable_object_cache disable_optimizer disable_parquet_prefetching disable_print_progress_bar disable_profile disable_profiling disable_progress_bar disable_timestamptz_casts disable_verification disable_verify_external disable_verify_fetch_row disable_verify_parallelism disable_verify_serializer disabled_compression_methods disabled_filesystems disabled_log_types disabled_optimizers discard distinct divide do document domain double drop duckdb_api duckdb_columns duckdb_constraints duckdb_databases duckdb_dependencies duckdb_extensions duckdb_external_file_cache duckdb_functions duckdb_indexes duckdb_keywords duckdb_log_contexts duckdb_logs duckdb_logs_parsed duckdb_memory duckdb_optimizers duckdb_prepared_statements duckdb_schemas duckdb_secret_types duckdb_secrets duckdb_sequences duckdb_settings duckdb_table_sample duckdb_tables duckdb_temporary_files duckdb_types duckdb_variables duckdb_views dynamic_or_filter_threshold each editdist3 element_at else enable enable_checkpoint_on_shutdown enable_external_access enable_external_file_cache enable_fsst_vectors enable_geoparquet_conversion enable_http_logging enable_http_metadata_cache enable_logging enable_macro_dependencies enable_object_cache enable_optimizer enable_print_progress_bar enable_profile enable_profiling enable_progress_bar enable_progress_bar_print enable_verification enable_view_dependencies enabled_log_types encode encoding encrypted end ends_with entropy enum enum_code enum_first enum_last enum_range enum_range_boundary epoch epoch_ms epoch_ns epoch_us equi_width_bins era error errors_as_json escape even event except exclude excluding exclusive execute exists exp explain explain_output export export_state extension extension_directory extension_versions extensions external external_threads extract factorial false family favg fdiv fetch file_search_path filter finalize first flatten float float4 float8 floor fmod following for force force_bitpacking_mode force_checkpoint force_compression foreign format formatReadableDecimalSize formatReadableSize format_bytes format_pg_type format_type forward freeze from from_base64 from_binary from_hex from_json from_json_strict fsum full function functions gamma gcd gen_random_uuid generate_series generate_subscripts generated geomean geometric_mean get_bit get_block_size get_current_time get_current_timestamp getvariable glob global grade_up grant granted greatest greatest_common_divisor group group_concat grouping grouping_id groups guid hamming handler having header hex histogram histogram_exact histogram_values hold home_directory hour hours http_logging_output http_proxy http_proxy_password http_proxy_username hugeint identity ieee_floating_point_ops if ignore ilike ilike_escape immediate immediate_transaction_mode immutable implicit import import_database in in_search_path include including increment index index_scan_max_count index_scan_percentage indexes inet_client_addr inet_client_port inet_server_addr inet_server_port inherit inherits initially inline inner inout input insensitive insert install instead instr int int1 int128 int16 int2 int32 int4 int64 int8 integer integer_division integral intersect interval into invoker is is_histogram_other_bin isfinite isinf isnan isnull isodow isolation isoyear jaccard jaro_similarity jaro_winkler_similarity join json json_array json_array_length json_contains json_deserialize_sql json_each json_execute_serialized_sql json_exists json_extract json_extract_path json_extract_path_text json_extract_string json_group_array json_group_object json_group_structure json_keys json_merge_patch json_object json_pretty json_quote json_serialize_plan json_serialize_sql json_structure json_transform json_transform_strict json_tree json_type json_valid json_value julian kahan_sum key kurtosis kurtosis_pop label lambda lambda_syntax language large last last_day late_materialization_max_rows lateral lcase lcm leading leakproof least least_common_multiple left left_grapheme len length length_grapheme level levenshtein lgamma like like_escape limit list list_aggr list_aggregate list_any_value list_append list_apply list_approx_count_distinct list_avg list_bit_and list_bit_or list_bit_xor list_bool_and list_bool_or list_cat list_concat list_contains list_cosine_distance list_cosine_similarity list_count list_distance list_distinct list_dot_product list_element list_entropy list_extract list_filter list_first list_grade_up list_has list_has_all list_has_any list_histogram list_indexof list_inner_product list_intersect list_kurtosis list_kurtosis_pop list_last list_mad list_max list_median list_min list_mode list_negative_dot_product list_negative_inner_product list_pack list_position list_prepend list_product list_reduce list_resize list_reverse list_reverse_sort list_select list_sem list_skewness list_slice list_sort list_stddev_pop list_stddev_samp list_string_agg list_sum list_transform list_unique list_value list_var_pop list_var_samp list_where list_zip listagg listen ln load local location lock lock_configuration locked log log10 log2 log_query_path logged logging_level logging_mode logging_storage logical long lower lpad ltrim macro mad make_date make_time make_timestamp make_timestamp_ns make_timestamptz map map_concat map_contains map_contains_entry map_contains_value map_entries map_extract map_extract_value map_from_entries map_keys map_to_pg_oid map_values mapping match materialized max max_by max_expression_depth max_memory max_temp_directory_size max_vacuum_tasks maxvalue md5 md5_number md5_number_lower md5_number_upper mean median memory_limit merge_join_threshold metadata_info method microsecond microseconds millennia millennium millisecond milliseconds min min_by minute minutes minvalue mismatches mod mode month monthname months move multiply name names nanosecond national natural nchar nested_loop_join_threshold new next nextafter nextval nfc_normalize no none normalized_interval not not_ilike_escape not_like_escape nothing notify notnull now nowait null null_order nullif nulls numeric nvarchar obj_description object octet_length of off offset oid oids old old_implicit_casting on only operator option options or ord order order_by_non_integer_literal ordered_aggregate_threshold ordinality others out outer over overlaps overlay overriding owned owner pandas_analyze_sample pandas_scan parallel parquet_bloom_probe parquet_file_metadata parquet_kv_metadata parquet_metadata parquet_metadata_cache parquet_scan parquet_schema parse_dirname parse_dirpath parse_duckdb_log_message parse_filename parse_path parser partial partition partitioned partitioned_write_flush_threshold partitioned_write_max_open_files passing password percent perfect_ht_threshold persistent pi pivot pivot_filter_threshold pivot_limit pivot_longer pivot_wider placing plans platform policy position positional pow power pragma pragma_collations pragma_database_size pragma_metadata_info pragma_platform pragma_show pragma_storage_info pragma_table_info pragma_user_agent pragma_version preceding precision prefer_range_joins prefetch_all_parquet_files prefix prepare prepared preserve preserve_identifier_case preserve_insertion_order primary printf prior privileges procedural procedure produce_arrow_string_view product profile_output profiling_mode profiling_output program progress_bar_time publication python_enable_replacements python_map_function python_scan_all_frames qualify quantile quantile_cont quantile_disc quarter quarters query query_table quote radians random range read read_blob read_csv read_csv_auto read_json read_json_auto read_json_objects read_json_objects_auto read_ndjson read_ndjson_auto read_ndjson_objects read_parquet read_text real reassign recheck recursive reduce ref references referencing refresh regexp_escape regexp_extract regexp_extract_all regexp_full_match regexp_matches regexp_replace regexp_split_to_array regexp_split_to_table regr_avgx regr_avgy regr_count regr_intercept regr_r2 regr_slope regr_sxx regr_sxy regr_syy reindex relative release remap_struct rename repeat repeat_row repeatable replace replica reservoir_quantile reset respect restart restrict returning returns reverse revoke right right_grapheme role rollback rollup round round_even roundbankers row row_to_json rows rpad rtrim rule sample savepoint scalar_subquery_error_on_multiple_rows scheduler_process_partial schema schemas scope scroll search search_path second seconds secret secret_directory security select sem semi seq_scan sequence sequences serializable server session session_user set set_bit setof sets setseed sha1 sha256 share shobj_description short show show_databases show_tables show_tables_expanded sign signbit signed similar simple sin sinh skewness skip smallint snapshot sniff_csv some sorted split split_part sql sqrt stable standalone start starts_with statement statistics stats stddev stddev_pop stddev_samp stdin stdout storage storage_compatibility_version storage_info stored str_split str_split_regex streaming_buffer_size strftime strict string string_agg string_split string_split_regex string_to_array strip strip_accents strlen strpos strptime struct struct_concat struct_extract struct_extract_at struct_insert struct_pack subscription substr substring substring_grapheme subtract suffix sum sum_no_overflow sumkahan summarize summary symmetric sysid system table table_info tables tablesample tablespace tan tanh temp temp_directory template temporary test_all_types test_vector_types text then threads ties time time_bucket timestamp timestamp_ms timestamp_ns timestamp_s timestamp_us timestamptz timetz timetz_byte_comparable timezone timezone_hour timezone_minute tinyint to to_base to_base64 to_binary to_centuries to_days to_decades to_hex to_hours to_json to_microseconds to_millennia to_milliseconds to_minutes to_months to_quarters to_seconds to_timestamp to_weeks to_years today trailing transaction transaction_timestamp transform translate treat trigger trim true trunc truncate truncate_duckdb_logs trusted try_cast try_strptime txid_current type typeof types ubigint ucase uhugeint uint128 uint16 uint32 uint64 uint8 uinteger unbin unbounded uncommitted unencrypted unhex unicode union union_extract union_tag union_value unique unknown unlisten unlogged unnest unpack unpivot unpivot_list until update upper url_decode url_encode use user user_agent username using usmallint utinyint uuid uuid_extract_timestamp uuid_extract_version uuidv4 uuidv7 vacuum valid validate validator value values var_pop var_samp varbinary varchar variable variadic variance varint varying vector_type verbose verify_external verify_fetch_row verify_parallelism verify_serializer version view views virtual volatile wal_autocheckpoint wavg week weekday weekofyear weeks weighted_avg when where which_secret whitespace window with within without work worker_threads wrapper write write_log xml xmlattributes xmlconcat xmlelement xmlexists xmlforest xmlnamespaces xmlparse xmlpi xmlroot xmlserialize xmltable xor year years yearweek yes zone zstd_min_string_length | || ~ ~~ ~~* ~~~`,
  types:
    "JSON bigint binary bit bitstring blob bool boolean bpchar bytea char date datetime dec decimal double enum float float4 float8 guid hugeint int int1 int128 int16 int2 int32 int4 int64 int8 integer integral interval list logical long map null numeric nvarchar oid real row short signed smallint string struct text time timestamp timestamp_ms timestamp_ns timestamp_s timestamp_us timestamptz timetz tinyint ubigint uhugeint uint128 uint16 uint32 uint64 uint8 uinteger union usmallint utinyint uuid varbinary varchar varint",
};

export const DuckDBDialect = SQLDialect.define(DuckDBDialectSpec);

/**
 * Record important keywords for the DuckDB dialect.
 */
export const DuckDBKeywords: Record<string, SqlKeywordInfo> = {
  array_agg: {
    description: "Returns a LIST containing all the values of a column.",
    example: "list(A)",
  },
  array_aggr: {
    description: "Executes the aggregate function name on the elements of list",
    example: "list_aggregate([1, 2, NULL], 'min')",
  },
  array_aggregate: {
    description: "Executes the aggregate function name on the elements of list",
    example: "list_aggregate([1, 2, NULL], 'min')",
  },
  array_apply: {
    description:
      "Returns a list that is the result of applying the lambda function to each element of the input list. See the Lambda Functions section for more details",
    example: "list_transform([1, 2, 3], x -> x + 1)",
  },
  array_cat: {
    description: "Concatenates two lists.",
    example: "list_concat([2, 3], [4, 5, 6])",
  },
  array_concat: {
    description: "Concatenates two lists.",
    example: "list_concat([2, 3], [4, 5, 6])",
  },
  array_contains: {
    description: "Returns true if the list contains the element.",
    example: "list_contains([1, 2, NULL], 1)",
  },
  array_cosine_distance: {
    description:
      "Compute the cosine distance between two arrays of the same size. The array elements can not be NULL. The arrays can have any size as long as the size is the same for both arguments.",
    example: "array_cosine_distance([1, 2, 3], [1, 2, 3])",
  },
  array_cosine_similarity: {
    description:
      "Compute the cosine similarity between two arrays of the same size. The array elements can not be NULL. The arrays can have any size as long as the size is the same for both arguments.",
    example: "array_cosine_similarity([1, 2, 3], [1, 2, 3])",
  },
  array_cross_product: {
    description:
      "Compute the cross product of two arrays of size 3. The array elements can not be NULL.",
    example: "array_cross_product([1, 2, 3], [1, 2, 3])",
  },
  array_distance: {
    description:
      "Compute the distance between two arrays of the same size. The array elements can not be NULL. The arrays can have any size as long as the size is the same for both arguments.",
    example: "array_distance([1, 2, 3], [1, 2, 3])",
  },
  array_distinct: {
    description:
      "Removes all duplicates and NULLs from a list. Does not preserve the original order",
    example: "list_distinct([1, 1, NULL, -3, 1, 5])",
  },
  array_dot_product: {
    description:
      "Compute the inner product between two arrays of the same size. The array elements can not be NULL. The arrays can have any size as long as the size is the same for both arguments.",
    example: "array_inner_product([1, 2, 3], [1, 2, 3])",
  },
  array_extract: {
    description: "Extract the indexth (1-based) value from the array.",
    example: "array_extract('DuckDB', 2)",
  },
  array_filter: {
    description:
      "Constructs a list from those elements of the input list for which the lambda function returns true",
    example: "list_filter([3, 4, 5], x -> x > 4)",
  },
  array_grade_up: {
    description: "Returns the index of their sorted position.",
    example: "list_grade_up([3, 6, 1, 2])",
  },
  array_has: {
    description: "Returns true if the list contains the element.",
    example: "list_contains([1, 2, NULL], 1)",
  },
  array_has_all: {
    description: "Returns true if all elements of l2 are in l1. NULLs are ignored.",
    example: "list_has_all([1, 2, 3], [2, 3])",
  },
  array_has_any: {
    description: "Returns true if the lists have any element in common. NULLs are ignored.",
    example: "list_has_any([1, 2, 3], [2, 3, 4])",
  },
  array_indexof: {
    description:
      "Returns the index of the element if the list contains the element. If the element is not found, it returns NULL.",
    example: "list_position([1, 2, NULL], 2)",
  },
  array_inner_product: {
    description:
      "Compute the inner product between two arrays of the same size. The array elements can not be NULL. The arrays can have any size as long as the size is the same for both arguments.",
    example: "array_inner_product([1, 2, 3], [1, 2, 3])",
  },
  array_length: {
    description: "Returns the length of the `list`.",
    example: "array_length([1,2,3])",
  },
  array_negative_dot_product: {
    description:
      "Compute the negative inner product between two arrays of the same size. The array elements can not be NULL. The arrays can have any size as long as the size is the same for both arguments.",
    example: "array_negative_inner_product([1, 2, 3], [1, 2, 3])",
  },
  array_negative_inner_product: {
    description:
      "Compute the negative inner product between two arrays of the same size. The array elements can not be NULL. The arrays can have any size as long as the size is the same for both arguments.",
    example: "array_negative_inner_product([1, 2, 3], [1, 2, 3])",
  },
  array_position: {
    description:
      "Returns the index of the element if the list contains the element. If the element is not found, it returns NULL.",
    example: "list_position([1, 2, NULL], 2)",
  },
  array_reduce: {
    description:
      "Returns a single value that is the result of applying the lambda function to each element of the input list, starting with the first element and then repeatedly applying the lambda function to the result of the previous application and the next element of the list. When an initial value is provided, it is used as the first argument to the lambda function",
    example: "list_reduce([1, 2, 3], (x, y) -> x + y)",
  },
  array_resize: {
    description:
      "Resizes the list to contain size elements. Initializes new elements with value or NULL if value is not set.",
    example: "list_resize([1, 2, 3], 5, 0)",
  },
  array_reverse_sort: {
    description: "Sorts the elements of the list in reverse order",
    example: "list_reverse_sort([3, 6, 1, 2])",
  },
  array_select: {
    description: "Returns a list based on the elements selected by the index_list.",
    example: "list_select([10, 20, 30, 40], [1, 4])",
  },
  array_slice: {
    description: "list_slice with added step feature.",
    example: "list_slice([4, 5, 6], 2, 3)",
  },
  array_sort: {
    description: "Sorts the elements of the list",
    example: "list_sort([3, 6, 1, 2])",
  },
  array_transform: {
    description:
      "Returns a list that is the result of applying the lambda function to each element of the input list. See the Lambda Functions section for more details",
    example: "list_transform([1, 2, 3], x -> x + 1)",
  },
  array_unique: {
    description: "Counts the unique elements of a list",
    example: "list_unique([1, 1, NULL, -3, 1, 5])",
  },
  array_value: {
    description: "Create an ARRAY containing the argument values.",
    example: "array_value(4, 5, 6)",
  },
  array_where: {
    description:
      "Returns a list with the BOOLEANs in mask_list applied as a mask to the value_list.",
    example: "list_where([10, 20, 30, 40], [true, false, false, true])",
  },
  array_zip: {
    description:
      "Zips k LISTs to a new LIST whose length will be that of the longest list. Its elements are structs of k elements from each list list_1, \u2026, list_k, missing elements are replaced with NULL. If truncate is set, all lists are truncated to the smallest list length.",
    example: "list_zip([1, 2], [3, 4], [5, 6])",
  },
  cast_to_type: {
    description: "Casts the first argument to the type of the second argument",
    example: "cast_to_type('42', NULL::INTEGER)",
  },
  concat: {
    description: "Concatenates many strings together.",
    example: "concat('Hello', ' ', 'World')",
  },
  concat_ws: {
    description: "Concatenates strings together separated by the specified separator.",
    example: "concat_ws(', ', 'Banana', 'Apple', 'Melon')",
  },
  contains: {
    description: "Returns true if the `list` contains the `element`.",
    example: "contains([1, 2, NULL], 1)",
  },
  count: {
    description: "Returns the number of non-null values in arg.",
    example: "count(A)",
  },
  count_if: {
    description: "Counts the total number of TRUE values for a boolean column",
    example: "count_if(A)",
  },
  countif: {
    description: "Counts the total number of TRUE values for a boolean column",
    example: "count_if(A)",
  },
  date_diff: {
    description: "The number of partition boundaries between the timestamps",
    example:
      "date_diff('hour', TIMESTAMPTZ '1992-09-30 23:59:59', TIMESTAMPTZ '1992-10-01 01:58:00')",
  },
  date_part: {
    description: "Get subfield (equivalent to extract)",
    example: "date_part('minute', TIMESTAMP '1992-09-20 20:38:40')",
  },
  date_sub: {
    description: "The number of complete partitions between the timestamps",
    example:
      "date_sub('hour', TIMESTAMPTZ '1992-09-30 23:59:59', TIMESTAMPTZ '1992-10-01 01:58:00')",
  },
  date_trunc: {
    description: "Truncate to specified precision",
    example: "date_trunc('hour', TIMESTAMPTZ '1992-09-20 20:38:40')",
  },
  datediff: {
    description: "The number of partition boundaries between the timestamps",
    example:
      "date_diff('hour', TIMESTAMPTZ '1992-09-30 23:59:59', TIMESTAMPTZ '1992-10-01 01:58:00')",
  },
  datepart: {
    description: "Get subfield (equivalent to extract)",
    example: "date_part('minute', TIMESTAMP '1992-09-20 20:38:40')",
  },
  datesub: {
    description: "The number of complete partitions between the timestamps",
    example:
      "date_sub('hour', TIMESTAMPTZ '1992-09-30 23:59:59', TIMESTAMPTZ '1992-10-01 01:58:00')",
  },
  datetrunc: {
    description: "Truncate to specified precision",
    example: "date_trunc('hour', TIMESTAMPTZ '1992-09-20 20:38:40')",
  },
  day: {
    description: "Extract the day component from a date or timestamp",
    example: "day(timestamp '2021-08-03 11:59:44.123456')",
  },
  dayname: {
    description: "The (English) name of the weekday",
    example: "dayname(TIMESTAMP '1992-03-22')",
  },
  dayofmonth: {
    description: "Extract the dayofmonth component from a date or timestamp",
    example: "dayofmonth(timestamp '2021-08-03 11:59:44.123456')",
  },
  dayofweek: {
    description: "Extract the dayofweek component from a date or timestamp",
    example: "dayofweek(timestamp '2021-08-03 11:59:44.123456')",
  },
  dayofyear: {
    description: "Extract the dayofyear component from a date or timestamp",
    example: "dayofyear(timestamp '2021-08-03 11:59:44.123456')",
  },
  generate_series: {
    description: "Create a list of values between start and stop - the stop parameter is inclusive",
    example: "generate_series(2, 5, 3)",
  },
  histogram: {
    description: "Returns a LIST of STRUCTs with the fields bucket and count.",
    example: "histogram(A)",
  },
  histogram_exact: {
    description:
      "Returns a LIST of STRUCTs with the fields bucket and count matching the buckets exactly.",
    example: "histogram_exact(A, [0, 1, 2])",
  },
  string_agg: {
    description: "Concatenates the column string values with an optional separator.",
    example: "string_agg(A, '-')",
  },
  string_split: {
    description: "Splits the `string` along the `separator`",
    example: "string_split('hello-world', '-')",
  },
  string_split_regex: {
    description: "Splits the `string` along the `regex`",
    example: "string_split_regex('hello world; 42', ';? ')",
  },
  string_to_array: {
    description: "Splits the `string` along the `separator`",
    example: "string_split('hello-world', '-')",
  },
  struct_concat: {
    description: "Merge the multiple STRUCTs into a single STRUCT.",
    example: "struct_concat(struct_pack(i := 4), struct_pack(s := 'string'))",
  },
  struct_extract: {
    description: "Extract the named entry from the STRUCT.",
    example: "struct_extract({'i': 3, 'v2': 3, 'v3': 0}, 'i')",
  },
  struct_extract_at: {
    description: "Extract the entry from the STRUCT by position (starts at 1!).",
    example: "struct_extract_at({'i': 3, 'v2': 3, 'v3': 0}, 2)",
  },
  struct_insert: {
    description:
      "Adds field(s)/value(s) to an existing STRUCT with the argument values. The entry name(s) will be the bound variable name(s)",
    example: "struct_insert({'a': 1}, b := 2)",
  },
  struct_pack: {
    description:
      "Create a STRUCT containing the argument values. The entry name will be the bound variable name.",
    example: "struct_pack(i := 4, s := 'string')",
  },
  substring: {
    description:
      "Extract substring of `length` characters starting from character `start`. Note that a start value of 1 refers to the first character of the `string`.",
    example: "substring('Hello', 2, 2)",
  },
  to_base: {
    description:
      "Converts a value to a string in the given base radix, optionally padding with leading zeros to the minimum length",
    example: "to_base(42, 16)",
  },
  to_base64: {
    description: "Converts a `blob` to a base64 encoded `string`.",
    example: "base64('A'::BLOB)",
  },
  to_binary: {
    description: "Converts the value to binary representation",
    example: "bin(42)",
  },
  to_centuries: {
    description: "Construct a century interval",
    example: "to_centuries(5)",
  },
  to_days: {
    description: "Construct a day interval",
    example: "to_days(5)",
  },
  to_decades: {
    description: "Construct a decade interval",
    example: "to_decades(5)",
  },
  to_hex: {
    description: "Converts the value to hexadecimal representation.",
    example: "hex(42)",
  },
  to_hours: {
    description: "Construct a hour interval",
    example: "to_hours(5)",
  },
  to_microseconds: {
    description: "Construct a microsecond interval",
    example: "to_microseconds(5)",
  },
  to_millennia: {
    description: "Construct a millenium interval",
    example: "to_millennia(1)",
  },
  to_milliseconds: {
    description: "Construct a millisecond interval",
    example: "to_milliseconds(5.5)",
  },
  to_minutes: {
    description: "Construct a minute interval",
    example: "to_minutes(5)",
  },
  to_months: {
    description: "Construct a month interval",
    example: "to_months(5)",
  },
  to_quarters: {
    description: "Construct a quarter interval",
    example: "to_quarters(5)",
  },
  to_seconds: {
    description: "Construct a second interval",
    example: "to_seconds(5.5)",
  },
  to_timestamp: {
    description: "Converts secs since epoch to a timestamp with time zone",
    example: "to_timestamp(1284352323.5)",
  },
  to_weeks: {
    description: "Construct a week interval",
    example: "to_weeks(5)",
  },
  to_years: {
    description: "Construct a year interval",
    example: "to_years(5)",
  },
  trim: {
    description: "Removes any spaces from either side of the string.",
    example: "trim('>>>>test<<', '><')",
  },
};
