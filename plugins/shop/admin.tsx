import { Badge, DataTable, defineAdminPlugin, PageHeader, type AdminPageProps } from "tansy/admin";
import { getT } from "tansy/server";
import { formatMoney as money, str, toMilli, fromMilli } from "./logic";
import { ORDERS, PRODUCTS, VARIANTS } from "./schema";

type Records = AdminPageProps["records"];
type Row = Record<string, unknown>;

/** As the signed-in person, so someone who can't read a collection gets nothing rather than another person's view. */
async function allRows(records: Records, slug: string, query: Record<string, unknown>, limit = 2000): Promise<Row[] | null> {
  try {
    const rows: Row[] = [];
    for (let page = 1; rows.length < limit; page++) {
      const result = await records.list(slug, { ...query, page, perPage: 200 });
      rows.push(...result.items);
      if (page >= result.totalPages) break;
    }
    return rows;
  } catch {
    return null;
  }
}

const MONTH = 30 * 24 * 60 * 60 * 1000;
const recent = (value: unknown) => typeof value === "string" && Date.now() - Date.parse(value) < MONTH;
const SOLD = new Set(["paid", "shipped", "delivered"]);

/** This plugin's words and formats in the person's interface language. */
async function words(userId: string) {
  const { t, locale, formatDate } = await getT(userId);
  return {
    t: (key: string, values?: Record<string, string | number>) => t(`ext.shop.${key}`, values),
    date: (value: unknown) => (typeof value === "string" && value ? formatDate(value) : "—"),
    formatMoney: (amount: number, currency: string) => money(amount, currency, locale),
  };
}

/** Products and variants with this many or fewer left are listed as running low. */
const LOW_STOCK = 5;

async function Overview({ records, user }: AdminPageProps) {
  const { t, date, formatMoney } = await words(user.id);
  const [orders, products, variants] = await Promise.all([
    allRows(records, ORDERS, { sort: "-createdAt", fields: "id,title,state,total,currency,email,country,paidAt,flag,needsShipping" }, 2000),
    allRows(records, PRODUCTS, { fields: "id,title,stock" }, 2000),
    allRows(records, VARIANTS, { fields: "id,title,product,stock" }, 2000),
  ]);
  if (!orders) {
    return <div className="cms-gutter"><PageHeader title={t("overview.title")} /><p className="cms-empty">{t("overview.cantReadOrders")}</p></div>;
  }
  const toShip = orders.filter((order) => order.state === "paid" && order.needsShipping === true);
  const flagged = orders.filter((order) => str(order.flag) && order.state !== "refunded" && order.state !== "cancelled");
  const sold = orders.filter((order) => SOLD.has(str(order.state)) && recent(order.paidAt));
  const currency = str(sold[0]?.currency) || str(orders[0]?.currency) || "usd";
  const revenue = fromMilli(sold.reduce((total, order) => total + toMilli(typeof order.total === "number" ? order.total : 0), 0));
  const productTitle = new Map((products ?? []).map((product) => [product.id, str(product.title)]));
  const low = [
    ...(products ?? []).filter((product) => typeof product.stock === "number" && product.stock <= LOW_STOCK).map((product) => ({ key: `p${String(product.id)}`, title: str(product.title), stock: product.stock as number })),
    ...(variants ?? []).filter((variant) => typeof variant.stock === "number" && variant.stock <= LOW_STOCK).map((variant) => ({ key: `v${String(variant.id)}`, title: `${productTitle.get(variant.product) || t("overview.product", { id: String(variant.product) })} · ${str(variant.title)}`, stock: variant.stock as number })),
  ].sort((a, b) => a.stock - b.stock);

  return (
    <div className="cms-gutter">
      <PageHeader title={t("overview.title")} description={t("overview.description")} />
      <div className="cms-stat-strip cms-mb-6">
        <div><p className="cms-stat-label">{t("overview.stats.orders")}</p><p className="cms-stat-value">{sold.length}</p></div>
        <div><p className="cms-stat-label">{t("overview.stats.revenue")}</p><p className="cms-stat-value">{formatMoney(revenue, currency)}</p></div>
        <div><p className="cms-stat-label">{t("overview.stats.toShip")}</p><p className="cms-stat-value">{toShip.length}</p></div>
        <div><p className="cms-stat-label">{t("overview.stats.pending")}</p><p className="cms-stat-value">{orders.filter((order) => order.state === "pending").length}</p></div>
      </div>

      <div className="cms-stack-6">
        <DataTable
          label={t("overview.toShip")}
          title={t("overview.toShip")}
          columns={[{ id: "order", label: t("columns.order") }, { id: "items", label: t("columns.items") }, { id: "customer", label: t("columns.customer") }, { id: "country", label: t("columns.country") }, { id: "paid", label: t("columns.paid") }, { id: "total", label: t("columns.total"), numeric: true }]}
          rows={toShip.map((order) => ({
            id: String(order.id),
            cells: {
              order: `#${String(order.id)}`,
              items: str(order.title) || null,
              customer: str(order.email) || null,
              country: str(order.country) || null,
              paid: date(order.paidAt),
              total: typeof order.total === "number" ? formatMoney(order.total, str(order.currency) || currency) : null,
            },
          }))}
          empty={{ title: t("overview.nothingToShip") }}
        />

        {flagged.length > 0 && (
          <DataTable
            label={t("overview.needsLook")}
            title={t("overview.needsLook")}
            columns={[{ id: "order", label: t("columns.order") }, { id: "state", label: t("columns.state") }, { id: "problem", label: t("columns.problem") }]}
            rows={flagged.map((order) => ({ id: String(order.id), cells: { order: `#${String(order.id)}`, state: <Badge>{str(order.state)}</Badge>, problem: str(order.flag) } }))}
            empty={{ title: "" }}
          />
        )}

        <DataTable
          label={t("overview.lowStock")}
          title={t("overview.lowStock")}
          columns={[{ id: "product", label: t("columns.product") }, { id: "left", label: t("columns.left"), numeric: true }]}
          rows={(products ? low : []).map((row) => ({ id: row.key, cells: { product: row.title, left: row.stock === 0 ? <Badge tone="warning">{t("overview.soldOut")}</Badge> : row.stock } }))}
          empty={{ title: products === null ? t("overview.cantReadProducts") : t("overview.nothingLow") }}
        />
      </div>
    </div>
  );
}

async function ToShip({ records, user }: AdminPageProps) {
  const { t } = await words(user.id);
  const orders = await allRows(records, ORDERS, { filter: 'state = "paid" || state = "pending"', fields: "state,needsShipping,flag" }, 2000);
  if (!orders) return <p className="cms-muted cms-text-sm">{t("widget.cantRead")}</p>;
  return (
    <ul className="cms-muted cms-text-sm">
      <li>{t("widget.toShip", { count: orders.filter((order) => order.state === "paid" && order.needsShipping === true).length })}</li>
      <li>{t("widget.pending", { count: orders.filter((order) => order.state === "pending").length })}</li>
      {orders.some((order) => str(order.flag)) && <li>{t("widget.needsLook")}</li>}
    </ul>
  );
}

/** A shopping bag, from Heroicons (MIT), drawn by the navigation like its own icons. */
const BAG = {
  viewBox: "0 0 16 16",
  fillRule: "evenodd" as const,
  paths: ["M5 4a3 3 0 0 1 6 0v1h.643a1.5 1.5 0 0 1 1.492 1.35l.7 7A1.5 1.5 0 0 1 12.342 15H3.657a1.5 1.5 0 0 1-1.492-1.65l.7-7A1.5 1.5 0 0 1 4.357 5H5V4Zm4.5 0v1h-3V4a1.5 1.5 0 0 1 3 0Zm-3 3.75a.75.75 0 0 0-1.5 0v1a3 3 0 1 0 6 0v-1a.75.75 0 0 0-1.5 0v1a1.5 1.5 0 1 1-3 0v-1Z"],
};

export default defineAdminPlugin({
  pages: [{ path: "shop/overview", title: "Overview", permission: "ext.shop:fulfill", component: Overview }],
  section: {
    title: "Shop",
    icon: BAG,
    items: [
      { page: "shop/overview" },
      { collection: ORDERS },
      { collection: PRODUCTS },
      { collection: VARIANTS },
      { collection: "shop-categories" },
      { collection: "shop-shipping-zones" },
      { collection: "shop-store", title: "Shop page" },
      { collection: "shop-cart", title: "Cart page" },
      { collection: "shop-account", title: "Orders page" },
      { settings: true },
    ],
  },
  widgets: [{ id: "shop-to-ship", title: "Shop", permission: "ext.shop:fulfill", component: ToShip }],
});
