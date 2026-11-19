import slugifyLibrary from "slugify";

const slugify = (str: string) => slugifyLibrary(str, { lower: true });

export default slugify;
