import { createSiteMetadata, createSitePage } from "tansy/site";
import components from "../../../.tansy/theme";
import renderers from "../../../.tansy/render";
import config from "../../../tansy.config";

export const dynamic = "force-dynamic";

const entry = { components, renderers };

export const generateMetadata = createSiteMetadata(config, entry);
export default createSitePage(config, entry);
