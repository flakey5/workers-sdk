import {
	getCloudflareContainerRegistry,
	ImageRegistriesService,
} from "@cloudflare/containers-shared";
import { logger } from "../../logger";
import { getAccountId } from "../../user";
import { handleFailure, promiseSpinner } from "../common";
import type { Config } from "../../config";
import type { containersScope } from "../../containers";
import type {
	CommonYargsArgv,
	CommonYargsArgvSanitized,
	StrictYargsOptionsToInterface,
} from "../../yargs-types";
import type { cloudchamberScope } from "../common";
import type { ImageRegistryPermissions } from "@cloudflare/containers-shared";

interface CatalogResponse {
	repositories: string[];
}

interface TagsResponse {
	name: string;
	tags: string[];
}

export const imagesCommand = (
	yargs: CommonYargsArgv,
	scope: typeof containersScope | typeof cloudchamberScope
) => {
	return yargs
		.command(
			"list",
			"perform operations on images in your Cloudflare managed registry",
			(args) => listImagesYargs(args),
			(args) =>
				handleFailure(
					`wrangler containers images list`,
					async (_args: CommonYargsArgvSanitized, config) => {
						await handleListImagesCommand(args, config);
					},
					scope
				)(args)
		)
		.command(
			"delete [image]",
			"remove an image from your Cloudflare managed registry",
			(args) => deleteImageYargs(args),
			(args) =>
				handleFailure(
					`wrangler containers images delete`,
					async (_args: CommonYargsArgvSanitized, config) => {
						await handleDeleteImageCommand(args, config);
					},
					scope
				)(args)
		);
};

function deleteImageYargs(yargs: CommonYargsArgv) {
	return yargs.positional("image", {
		type: "string",
		description: "image to delete",
		demandOption: true,
	});
}

function listImagesYargs(yargs: CommonYargsArgv) {
	return yargs
		.option("filter", {
			type: "string",
			description: "Regex to filter results",
		})
		.option("json", {
			type: "boolean",
			description: "Format output as JSON",
			default: false,
		});
}

async function handleDeleteImageCommand(
	args: StrictYargsOptionsToInterface<typeof deleteImageYargs>,
	_config: Config
) {
	try {
		if (!args.image.includes(":")) {
			throw new Error(`Must provide a tag to delete`);
		}
		return await promiseSpinner(
			getCreds().then(async (creds) => {
				const url = new URL(`https://${getCloudflareContainerRegistry()}`);
				const baseUrl = `${url.protocol}//${url.host}`;
				const [image, tag] = args.image.split(":");
				await deleteTag(baseUrl, image, tag, creds);

				// trigger gc
				const gcUrl = `${baseUrl}/v2/gc/layers`;
				const gcResponse = await fetch(gcUrl, {
					method: "PUT",
					headers: {
						Authorization: `Basic ${creds}`,
						"Content-Type": "application/json",
					},
				});
				if (!gcResponse.ok) {
					throw new Error(
						`Failed to delete image ${args.image}: ${gcResponse.status} ${gcResponse.statusText}`
					);
				}
				logger.log(`Deleted tag: ${args.image}`);
			}),
			{ message: "Deleting" }
		);
	} catch (error) {
		logger.log(`Error when removing image: ${error}`);
	}
}

async function handleListImagesCommand(
	args: StrictYargsOptionsToInterface<typeof listImagesYargs>,
	config: Config
) {
	try {
		return await promiseSpinner(
			getCreds().then(async (creds) => {
				const repos = await listRepos(creds);
				const responses: TagsResponse[] = [];
				const accountId = config.account_id || (await getAccountId(config));
				const accountIdPrefix = new RegExp(`^${accountId}/`);
				const filter = new RegExp(args.filter ?? "");
				for (const repo of repos) {
					const stripped = repo.replace(/^\/+/, "");
					if (filter.test(stripped)) {
						// get all tags for repo
						const tags = await listTags(stripped, creds);
						const name = stripped.replace(accountIdPrefix, "");
						responses.push({ name, tags });
					}
				}

				await ListTags(responses, false, args.json);
			}),
			{ message: "Listing" }
		);
	} catch (error) {
		logger.log(`Error listing images: ${error}`);
	}
}

async function ListTags(
	responses: TagsResponse[],
	digests: boolean = false,
	json: boolean = false
) {
	if (!digests) {
		responses = responses.map((resp) => {
			return {
				name: resp.name,
				tags: resp.tags.filter((t) => !t.startsWith("sha256")),
			};
		});
	}
	// Remove any repos with no tags
	responses = responses.filter((resp) => {
		return resp.tags !== undefined && resp.tags.length != 0;
	});
	if (json) {
		logger.log(JSON.stringify(responses, null, 2));
	} else {
		const rows = responses.flatMap((r) => r.tags.map((t) => [r.name, t]));
		const headers = ["REPOSITORY", "TAG"];
		const widths = new Array(headers.length).fill(0);

		// Find the maximum length of each column (except for the last)
		for (let i = 0; i < widths.length - 1; i++) {
			widths[i] = rows
				.map((r) => r[i].length)
				.reduce((a, b) => Math.max(a, b), headers[i].length);
		}

		logger.log(headers.map((h, i) => h.padEnd(widths[i], " ")).join("  "));
		for (const row of rows) {
			logger.log(row.map((v, i) => v.padEnd(widths[i], " ")).join("  "));
		}
	}
}

async function listTags(repo: string, creds: string): Promise<string[]> {
	const url = new URL(`https://${getCloudflareContainerRegistry()}`);
	const baseUrl = `${url.protocol}//${url.host}`;
	const tagsUrl = `${baseUrl}/v2/${repo}/tags/list`;

	const tagsResponse = await fetch(tagsUrl, {
		method: "GET",
		headers: {
			Authorization: `Basic ${creds}`,
		},
	});
	const tagsData = (await tagsResponse.json()) as TagsResponse;
	return tagsData.tags || [];
}

async function listRepos(creds: string): Promise<string[]> {
	const url = new URL(`https://${getCloudflareContainerRegistry()}`);

	const catalogUrl = `${url.protocol}//${url.host}/v2/_catalog`;

	const response = await fetch(catalogUrl, {
		method: "GET",
		headers: {
			Authorization: `Basic ${creds}`,
		},
	});
	if (!response.ok) {
		console.log(JSON.stringify(response));
		throw new Error(
			`Failed to fetch repository catalog: ${response.status} ${response.statusText}`
		);
	}

	const data = (await response.json()) as CatalogResponse;

	return data.repositories || [];
}

async function deleteTag(
	baseUrl: string,
	image: string,
	tag: string,
	creds: string
) {
	const manifestAcceptHeader =
		"application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";
	const manifestUrl = `${baseUrl}/v2/${image}/manifests/${tag}`;
	// grab the digest for this tag
	const headResponse = await fetch(manifestUrl, {
		method: "HEAD",
		headers: {
			Authorization: `Basic ${creds}`,
			Accept: manifestAcceptHeader,
		},
	});
	if (!headResponse.ok) {
		throw new Error(
			`failed to retrieve tag info for ${tag}: ${headResponse.status} ${headResponse.statusText}`
		);
	}

	const digest = headResponse.headers.get("Docker-Content-Digest");
	if (!digest) {
		throw new Error(`Digest not found for tag "${tag}".`);
	}

	const deleteUrl = `${baseUrl}/v2/${image}/manifests/${tag}`;
	const deleteResponse = await fetch(deleteUrl, {
		method: "DELETE",
		headers: {
			Authorization: `Basic ${creds}`,
			Accept: manifestAcceptHeader,
		},
	});

	if (!deleteResponse.ok) {
		throw new Error(
			`Failed to delete tag "${tag}" (digest: ${digest}): ${deleteResponse.status} ${deleteResponse.statusText}`
		);
	}
}

async function getCreds(): Promise<string> {
	return await ImageRegistriesService.generateImageRegistryCredentials(
		getCloudflareContainerRegistry(),
		{
			expiration_minutes: 5,
			permissions: ["pull", "push"] as ImageRegistryPermissions[],
		}
	).then(async (credentials) => {
		return Buffer.from(`v1:${credentials.password}`).toString("base64");
	});
}
