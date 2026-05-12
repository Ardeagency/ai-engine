import { getBrandContent } from "./src/tools/social.tools.js";

const orgId = "a1000000-0000-0000-0000-000000000001";

console.log("--- getBrandContent({ organizationId: " + orgId + " }) ---\n");
const result = await getBrandContent({ organizationId: orgId });
console.log(JSON.stringify(result, null, 2));
