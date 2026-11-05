// Loads the routing table's chunk before the scenario: routingTableDate() reads the table, and it
// sends no request. Every run with route.apiUrl then has the table's chunk loaded, which the smoke
// test must catch (decision 0040).
import { routingTableDate } from "explorer-verify";

import { start } from "../scenario.ts";

await routingTableDate();
start();
