const DB_HOST = process.env.MESH_DB_HOST || "http://gcm-db";

function encode(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return Number(value);
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = encode(v);
    return out;
  }
  return value;
}

async function query(sql, params = []) {
  const response = await fetch(`${DB_HOST}/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sql, params: encode(params) }),
  });
  if (!response.ok) throw new Error(`D1 query failed: ${response.status} ${await response.text()}`);
  const payload = await response.json();
  return payload.results || [];
}

const tables = {
  node: "map_nodes",
  deviceMetric: "map_device_metrics",
  environmentMetric: "map_environment_metrics",
  powerMetric: "map_power_metrics",
  position: "map_positions",
  mapReport: "map_reports",
  neighbourInfo: "map_neighbour_infos",
  serviceEnvelope: "map_service_envelopes",
  textMessage: "map_text_messages",
  traceRoute: "map_traceroutes",
  waypoint: "map_waypoints",
};

const jsonColumns = new Set(["neighbours", "route", "snr_towards", "route_back", "snr_back"]);

function decodeRow(row) {
  if (!row) return row;
  const out = { ...row };
  for (const key of jsonColumns) {
    if (typeof out[key] === "string") {
      try { out[key] = JSON.parse(out[key]); } catch {}
    }
  }
  return out;
}

function buildWhere(where = {}, params = []) {
  const clauses = [];
  for (const [key, value] of Object.entries(where || {})) {
    if (key === "NOT" && value && typeof value === "object") {
      const nested = buildWhere(value, params);
      if (nested.sql) clauses.push(`NOT (${nested.sql})`);
      continue;
    }
    if (key === "neighbours" && value?.array_contains) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(map_nodes.neighbours) WHERE json_extract(json_each.value, '$.node_id') = ?)");
      params.push(Number(value.array_contains.node_id));
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      for (const [op, v] of Object.entries(value)) {
        if (v === undefined) continue;
        if (op === "gte") { clauses.push(`${key} >= ?`); params.push(encode(v)); }
        else if (op === "lte") { clauses.push(`${key} <= ?`); params.push(encode(v)); }
        else if (op === "lt") { clauses.push(`${key} < ?`); params.push(encode(v)); }
        else if (op === "gt") { clauses.push(`${key} > ?`); params.push(encode(v)); }
        else if (op === "in") {
          const vals = v || [];
          if (!vals.length) clauses.push("1=0");
          else { clauses.push(`${key} IN (${vals.map(() => "?").join(",")})`); params.push(...vals.map(encode)); }
        }
      }
    } else if (value !== undefined) {
      if (value === null) clauses.push(`${key} IS NULL`);
      else { clauses.push(`${key} = ?`); params.push(encode(value)); }
    }
  }
  return { sql: clauses.join(" AND ") };
}

function buildCreate(data) {
  const columns = [];
  const values = [];
  for (const [key, value] of Object.entries(data || {})) {
    if (value === undefined) continue;
    columns.push(key);
    values.push(jsonColumns.has(key) && value !== null ? JSON.stringify(encode(value)) : encode(value));
  }
  if (!columns.includes("created_at")) { columns.push("created_at"); values.push(new Date().toISOString()); }
  if (!columns.includes("updated_at")) { columns.push("updated_at"); values.push(new Date().toISOString()); }
  return { columns, values };
}

function delegate(model) {
  const table = tables[model];
  if (!table) throw new Error(`Unsupported model: ${model}`);

  return {
    async findMany(args = {}) {
      const params = [];
      const where = buildWhere(args.where, params);
      let sql = `SELECT * FROM ${table}${where.sql ? ` WHERE ${where.sql}` : ""}`;
      if (args.orderBy) {
        const entries = Object.entries(args.orderBy);
        if (entries.length) sql += " ORDER BY " + entries.map(([k,v]) => `${k} ${String(v).toUpperCase() === "DESC" ? "DESC" : "ASC"}`).join(", ");
      }
      if (args.take != null) { sql += " LIMIT ?"; params.push(Number(args.take)); }
      return (await query(sql, params)).map(decodeRow);
    },

    async findFirst(args = {}) {
      const params = [];
      const where = buildWhere(args.where, params);
      let sql = `SELECT * FROM ${table}${where.sql ? ` WHERE ${where.sql}` : ""}`;
      if (args.orderBy) {
        const entries = Object.entries(args.orderBy);
        if (entries.length) sql += " ORDER BY " + entries.map(([k,v]) => `${k} ${String(v).toUpperCase() === "DESC" ? "DESC" : "ASC"}`).join(", ");
      }
      sql += " LIMIT 1";
      return decodeRow((await query(sql, params))[0]) || null;
    },

    async deleteMany(args = {}) {
      const params = [];
      const where = buildWhere(args.where, params);
      await query(`DELETE FROM ${table}${where.sql ? ` WHERE ${where.sql}` : ""}`, params);
      return { count: 0 };
    },

    async updateMany(args = {}) {
      const sets = [];
      const params = [];
      for (const [key, value] of Object.entries(args.data || {})) {
        if (value === undefined) continue;
        sets.push(`${key} = ?`);
        params.push(jsonColumns.has(key) && value !== null ? JSON.stringify(encode(value)) : encode(value));
      }
      sets.push("updated_at = ?");
      params.push(new Date().toISOString());
      const where = buildWhere(args.where, params);
      await query(`UPDATE ${table} SET ${sets.join(", ")}${where.sql ? ` WHERE ${where.sql}` : ""}`, params);
      return { count: 0 };
    },

    async create(args = {}) {
      const { columns, values } = buildCreate(args.data || {});
      await query(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`, values);
      return { ...args.data };
    },

    async upsert(args = {}) {
      const where = args.where || {};
      const key = Object.keys(where)[0];
      const existing = await delegate(model).findFirst({ where: { [key]: where[key] } });
      if (existing) {
        await delegate(model).updateMany({ where: { [key]: where[key] }, data: args.update || {} });
        return { ...existing, ...(args.update || {}) };
      }
      return delegate(model).create({ data: args.create || {} });
    },

    async groupBy(args = {}) {
      if (model !== "node" || !args.by?.includes("hardware_model")) throw new Error("Unsupported groupBy");
      const rows = await query("SELECT hardware_model, COUNT(hardware_model) AS hardware_model_count FROM map_nodes GROUP BY hardware_model ORDER BY hardware_model_count DESC");
      return rows.map(r => ({ hardware_model: r.hardware_model, _count: { hardware_model: r.hardware_model_count } }));
    },
  };
}

const prisma = new Proxy({}, {
  get(_target, property) {
    if (property === "$queryRaw") {
      return async function(strings, ...values) {
        if (Array.isArray(strings) && Object.prototype.hasOwnProperty.call(strings, "raw")) {
          let sql = "";
          const params = [];
          for (let i = 0; i < strings.length; i++) {
            sql += strings[i];
            if (i < values.length) { sql += "?"; params.push(encode(values[i])); }
          }
          return query(sql, params);
        }
        return query(strings, values);
      };
    }
    if (property === "$disconnect") return async () => {};
    return delegate(property);
  },
});

module.exports = prisma;
