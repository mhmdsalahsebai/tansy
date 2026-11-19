import { PageHeader } from "../../../../components/ui/kit";
import { requirePage } from "../../../../core/authz/page";
import { getT } from "../../../../core/i18n/admin";
import { DIRECTORY_KEYWORDS, loadDirectory, type DirectoryEntry } from "../../../../core/extend/directory";

type Translate = Awaited<ReturnType<typeof getT>>["t"];

function Listing({ title, keyword, entries, t }: { title: string; keyword: string; entries: DirectoryEntry[]; t: Translate }) {
  return (
    <section className="cms-mb-8">
      <h2 className="cms-section-title cms-mb-2">{title}</h2>
      {entries.length === 0 ? <p className="cms-empty cms-empty-sm">{t("extensions.noPackages", { keyword })}</p> : (
        <div className="cms-table-wrap">
          <table className="cms-table cms-text-sm">
            <thead className="cms-thead"><tr><th scope="col" className="cms-cell">{t("extensions.package")}</th><th scope="col" className="cms-cell">{t("extensions.version")}</th><th scope="col" className="cms-cell">{t("extensions.packageDescription")}</th></tr></thead>
            <tbody className="cms-divide">
              {entries.map((entry) => (
                <tr key={entry.name}>
                  <td className="cms-cell cms-mono cms-strong"><a href={entry.url} target="_blank" rel="noopener noreferrer">{entry.name}</a></td>
                  <td className="cms-cell cms-soft">{entry.version}</td>
                  <td className="cms-cell cms-soft">{entry.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default async function Page() {
  const principal = await requirePage("setting:read");
  const { t } = await getT(principal.user.id);
  const directory = await loadDirectory();
  return (
    <div className="cms-gutter">
      <PageHeader title={t("extensions.directoryTitle")} description={t("extensions.directoryDescription")} />
      <p className="cms-mb-8"><strong>{t("extensions.notEndorsed")}</strong> {t("extensions.notEndorsedDetail")}</p>
      {directory ? (
        <>
          <Listing title={t("extensions.plugins")} keyword={DIRECTORY_KEYWORDS.plugins} entries={directory.plugins} t={t} />
          <Listing title={t("extensions.themes")} keyword={DIRECTORY_KEYWORDS.themes} entries={directory.themes} t={t} />
        </>
      ) : <p className="cms-empty cms-empty-sm">{t("extensions.npmUnreachable")}</p>}
    </div>
  );
}
