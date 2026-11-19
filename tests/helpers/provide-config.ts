import config from "@/tansy.config";
import { provideCmsConfig } from "@/core/config";

// instrumentation.ts does this on a real server.
provideCmsConfig(config);
