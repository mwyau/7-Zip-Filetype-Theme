import { fileURLToPath } from 'node:url';

export function validateReleaseEnvironment(environment, expectedOwner) {
  if (environment?.name !== 'release') throw new Error('Required GitHub environment "release" is missing.');
  if (environment.can_admins_bypass !== false) throw new Error('The release environment allows administrator bypass; disable bypass before publication.');
  const reviewers = (environment.protection_rules ?? [])
    .filter((rule) => rule.type === 'required_reviewers')
    .flatMap((rule) => rule.reviewers ?? []);
  const owner = expectedOwner.toLowerCase();
  if (!reviewers.some((entry) => entry.type === 'User' && entry.reviewer?.login?.toLowerCase() === owner)) {
    throw new Error(`The release environment must require repository owner ${expectedOwner} as a reviewer.`);
  }
  return { environment: 'release', reviewer: expectedOwner, administratorBypass: false };
}

async function verify() {
  const repository = process.env.GITHUB_REPOSITORY;
  const [owner, name] = repository?.split('/') ?? [];
  if (!owner || !name || repository.split('/').length !== 2) throw new Error('GITHUB_REPOSITORY must be set to owner/repository.');
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': '7-Zip-Filetype-Theme-release-guard' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com/repos/${owner}/${name}/environments/release`, { headers });
  if (!response.ok) throw new Error(`Cannot verify release environment protection (${response.status}).`);
  return validateReleaseEnvironment(await response.json(), owner);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await verify();
    console.log(`Verified ${result.environment}: required reviewer ${result.reviewer}; administrator bypass disabled.`);
  } catch (error) {
    console.error(`Release approval guard failed: ${error.message}`);
    process.exitCode = 1;
  }
}
