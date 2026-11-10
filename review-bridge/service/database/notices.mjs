// What the database says to the person while a command runs, apart from the module that loads pg: the
// command entry puts in the sentence in the project's language; without it the sentence is English. It
// goes to stderr, since a command's stdout may be JSON.
let backedUp = (folder) => process.stderr.write("Backed up the database to " + folder + " before upgrading it.\n");

export function onDatabaseBackedUp(report) {
  backedUp = report;
}

export async function databaseBackedUp(folder) {
  await backedUp(folder);
}
