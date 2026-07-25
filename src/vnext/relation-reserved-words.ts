type SqlRelationReservedWordKind =
  | "bigquery"
  | "dremio"
  | "duckdb"
  | "postgresql";

const MAX_RESERVED_WORD_LENGTH = 64;

// Source: https://cloud.google.com/bigquery/docs/reference/standard-sql/lexical#reserved_keywords
const BIGQUERY_RESERVED_WORDS: ReadonlySet<string> = new Set(
  "all and any array as asc assert_rows_modified at between by case cast collate contains create cross cube current default define desc distinct else end enum escape except exclude exists extract false fetch following for from full graph_table group grouping groups hash having if ignore in inner intersect interval into is join lateral left like limit lookup merge natural new no not null nulls of on or order outer over partition preceding proto qualify range recursive respect right rollup rows select set some struct tablesample then to treat true unbounded union unnest using when where window with within".split(
    " ",
  ),
);

// Source: https://docs.dremio.com/current/reference/sql/reserved-keywords/
// Kept local so this SSR-safe module does not import the CodeMirror dialect.
const DREMIO_RESERVED_WORDS: ReadonlySet<string> = new Set(
  "abs access acos aes_decrypt aggregate all allocate allow alter analyze and any approx_count_distinct approx_percentile are array array_avg array_cat array_compact array_contains array_generate_range array_max array_max_cardinality array_min array_position array_remove array_remove_at array_size array_sum array_to_string arrow as ascii asensitive asin assign asymmetric at atan atan2 atomic authorization auto avg avoid base64 batch begin begin_frame begin_partition between bigint bin bin_pack binary binary_string bit bit_and bit_length bit_or bitwise_and bitwise_not bitwise_or bitwise_xor blob bool_and bool_or boolean both branch bround btrim by cache call called cardinality cascaded case cast catalog cbrt ceil ceiling change char char_length character character_length check chr classifier clob close cloud coalesce col_like collate collect column columns commit commits_older_than compute concat concat_ws condition connect constraint contains convert convert_from convert_replaceutf8 convert_timezone convert_to copy corr corresponding cos cosh cot count covar_pop covar_samp crc32 create cross cube cume_dist current current_catalog current_date current_date_utc current_default_transform_group current_path current_role current_row current_schema current_time current_timestamp current_transform_group_for_type current_user cursor cycle data databases datasets date date_add date_diff date_format date_part date_sub date_trunc datediff datetype day dayofmonth dayofweek dayofyear deallocate dec decimal declare dedupe_lookback_period default define degrees delete dense_rank deref describe deterministic dimensions disallow disconnect display distinct double drop dynamic e each element else empty empty_as_null encode end end-exec end_frame end_partition ends_with engine equals escape escape_char every except exec execute exists exp expire explain extend external extract factorial false fetch field field_delimiter file_format files filter first_value flatten float floor folder for foreign frame_row free from from_hex full function fusion geo_beyond geo_distance geo_nearby get global grant grants greatest group grouping groups hash hash64 having hex history hold hour identity if ilike imindir import in include indicator initcap initial inner inout insensitive insert instr int integer intersect intersection interval into is is_bigint is_int is_member is_substr is_utf8 is_varchar isdate isnumeric job join json_array json_arrayagg json_exists json_object json_objectagg json_query json_value lag language large last_day last_query_id last_value lateral lazy lcase lead leading least left length levenshtein like like_regex limit listagg ln local localsort localtime localtimestamp locate log log10 logs lower lpad lshift ltrim manifests map_keys map_values mask mask_first_n mask_hash mask_last_n mask_show_first_n mask_show_last_n masking match match_number match_recognize matches max max_file_size_mb maxdir md5 measures median member merge metadata method min min_file_size_mb min_input_files mindir minus minute missing mod modifies module monitor month months_between more multiset national natural nchar nclob ndv new next next_day no none normalize normalize_string not notification_provider notification_queue_reference now nth_value ntile null null_if nullif numeric nvl occurrences_regex octet_length of offset old older_than omit on one only open operate optimize or order orphan out outer over overlaps overlay ownership parameter parse_url partition partitions pattern per percent percent_rank percentile_cont percentile_disc period permute pi pivot pmod policy portion position position_regex pow power precedes precision prepare prev primary procedure project promotion qualify quarter query query_user quote quote_char radians random range rank raw reads real record_delimiter recursive ref reference references referencing reflection reflections refresh regex regexp_col_like regexp_extract regexp_like regexp_matches regexp_replace regexp_split regr_avgx regr_avgy regr_count regr_intercept regr_r2 regr_slope regr_sxy regr_syy release remove rename repeat repeatstr replace reset result retain_last retain_last_commits retain_last_snapshots return returns reverse revoke rewrite right role rollback rollup round route row row_number rows rpad rshift rtrim running savepoint schemas scope scroll search second seek select sensitive session_user set sha sha1 sha256 sha512 show sign similar similar_to sin sinh size skip smallint snapshot snapshots snapshots_older_than some soundex specific specifictype split_part sql sqlexception sqlstate sqlwarning sqrt st_fromgeohash st_geohash start starts_with static statistics stddev stddev_pop stddev_samp stream string_binary strpos submultiset subset substr substring substring_index substring_regex succeeds sum symmetric system system_time system_user table tables tablesample tag tan tanh target_file_size_mb tblproperties then time time_format timestamp timestamp_format timestampadd timestampdiff timestamptype timezone_hour timezone_minute tinyint to to_char to_date to_hex to_number to_time to_timestamp toascii trailing transaction_timestamp translate translate_regex translation treat trigger trim trim_array trim_space true truncate typeof ucase uescape unbase64 unhex union unique unix_timestamp unknown unnest unpivot unset update upper upsert usage use user using vacuum value value_of values var_pop var_samp varbinary varchar varying versioning view views week weekofyear when whenever where width_bucket window with within without write xor year".split(
    " ",
  ),
);

// Source: DuckDB 1.4.5
// SELECT keyword_name FROM duckdb_keywords()
// WHERE keyword_category = 'reserved' ORDER BY keyword_name;
const DUCKDB_RESERVED_WORDS: ReadonlySet<string> = new Set(
  "all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create default deferrable desc describe distinct do else end except false fetch for foreign from group having in initially intersect into lambda lateral leading limit not null offset on only or order pivot pivot_longer pivot_wider placing primary qualify references returning select show some summarize symmetric table then to trailing true union unique unpivot using variadic when where window with".split(
    " ",
  ),
);

// Source: https://github.com/postgres/postgres/blob/REL_18_STABLE/src/include/parser/kwlist.h
// RESERVED_KEYWORD and TYPE_FUNC_NAME_KEYWORD entries: both categories are
// disallowed as unquoted column or relation names.
const POSTGRESQL_RESERVED_WORDS: ReadonlySet<string> = new Set(
  "all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column concurrently constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign freeze from full grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit localtime localtimestamp natural not notnull null offset on only or order outer overlaps placing primary references returning right select session_user similar some symmetric system_user table tablesample then to trailing true union unique user using variadic verbose when where window with".split(
    " ",
  ),
);

function asciiLowercase(value: string): string | null {
  if (
    value.length === 0 ||
    value.length > MAX_RESERVED_WORD_LENGTH
  ) {
    return null;
  }
  let hasUppercase = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 65 && code <= 90) {
      hasUppercase = true;
      continue;
    }
    if (
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 45 ||
      code === 95
    ) {
      continue;
    }
    return null;
  }
  if (!hasUppercase) {
    return value;
  }
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    output += String.fromCharCode(
      code >= 65 && code <= 90 ? code + 32 : code,
    );
  }
  return output;
}

export function isSqlRelationReservedWord(
  kind: SqlRelationReservedWordKind,
  value: string,
): boolean {
  const word = asciiLowercase(value);
  if (word === null) {
    return false;
  }
  switch (kind) {
    case "bigquery":
      return BIGQUERY_RESERVED_WORDS.has(word);
    case "dremio":
      return DREMIO_RESERVED_WORDS.has(word);
    case "duckdb":
      return DUCKDB_RESERVED_WORDS.has(word);
    case "postgresql":
      return POSTGRESQL_RESERVED_WORDS.has(word);
    default:
      return false;
  }
}
