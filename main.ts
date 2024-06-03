import {
	App,
	Plugin,
	TFile,
	moment,
	MarkdownView,
	PluginSettingTab,
	Setting,
} from "obsidian";

interface UpdateModifiedTimeSettings {
	debug: boolean;
	autoUpdate: boolean;
}

const DEFAULT_SETTINGS: UpdateModifiedTimeSettings = {
	debug: false,
	autoUpdate: true,
};

async function calculateChecksum(file: TFile, vault: any): Promise<string> {
	const fileContent = await vault.readBinary(file);
	const textContent = new TextDecoder("utf-8").decode(fileContent);
	const buffer = new TextEncoder().encode(textContent);
	const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashHex = hashArray
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return hashHex;
}

export default class UpdateModifiedTimePlugin extends Plugin {
	settings: UpdateModifiedTimeSettings;
	private lastActiveFile: TFile | null = null;
	private lastChecksum: string | null = null;

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new UpdateModifiedTimeSettingTab(this.app, this));

		// Register the command to manually update modified time
		this.addCommand({
			id: "update-modified-time",
			name: "Update modified time",
			checkCallback: (checking: boolean) => {
				const markdownView =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					if (!checking) {
						this.updateModifiedTime(markdownView.file);
					}
					return true;
				}
				return false;
			},
		});

		// Register event to listen for when the user switches files or closes a file
		if (this.settings.autoUpdate) {
			this.registerEvent(
				this.app.workspace.on("active-leaf-change", () =>
					this.handleFileChange()
				)
			);
			this.registerEvent(
				this.app.workspace.on("file-open", () =>
					this.handleFileChange()
				)
			);
		}
	}

	async handleFileChange() {
		const markdownView =
			this.app.workspace.getActiveViewOfType(MarkdownView);
		const currentFile = markdownView ? markdownView.file : null;

		if (this.lastActiveFile) {
			const currentChecksum = await calculateChecksum(
				this.lastActiveFile,
				this.app.vault
			);
			if (this.lastChecksum !== currentChecksum) {
				await this.updateModifiedTime(this.lastActiveFile);
			}
		}

		this.lastActiveFile = currentFile;
		this.lastChecksum = currentFile
			? await calculateChecksum(currentFile, this.app.vault)
			: null;
	}

	async updateModifiedTime(file: TFile | null) {
		if (!file) {
			if (this.settings.debug) {
				console.log("No file provided, skipping update.");
			}
			return;
		}

		if (this.settings.debug) {
			console.log(`Updating modified time for file: ${file.path}`);
		}

		if (file.extension !== "md") {
			if (this.settings.debug) {
				console.log("File is not a markdown file, skipping.");
			}
			return;
		}

		try {
			const fileContent = await this.app.vault.readBinary(file);
			const textContent = new TextDecoder("utf-8").decode(fileContent);

			if (this.settings.debug) {
				console.log("File content read successfully");
			}

			const yamlRegex = /^---\n([\s\S]*?)\n---/;
			const match = textContent.match(yamlRegex);
			const currentTime = moment().format("YYYY-MM-DDTHH:mm:ssZ");

			if (!match) {
				if (this.settings.debug) {
					console.log("No YAML front matter found, skipping update.");
				}
				return;
			}

			const yamlContent = match[1];
			let newYamlContent;
			let updatedYaml = false;

			if (yamlContent.includes("modified:")) {
				if (this.settings.debug) {
					console.log("Existing modified field found, updating it");
				}
				newYamlContent = yamlContent.replace(
					/modified: .*/,
					`modified: ${currentTime}`
				);
				updatedYaml = true;
			} else {
				if (this.settings.debug) {
					console.log("No modified field found, adding it");
				}
				newYamlContent = yamlContent + `\nmodified: ${currentTime}`;
				updatedYaml = true;
			}

			if (updatedYaml) {
				const newFileContent = textContent.replace(
					yamlRegex,
					`---\n${newYamlContent}\n---`
				);

				if (this.settings.debug) {
					console.log("New file content prepared");
				}

				await this.app.vault.modifyBinary(
					file,
					new TextEncoder().encode(newFileContent)
				);
				if (this.settings.debug) {
					console.log("File content updated and saved");
				}
			} else {
				if (this.settings.debug) {
					console.log("No changes made to the YAML front matter");
				}
			}
		} catch (error) {
			if (this.settings.debug) {
				console.error("Error updating file", error);
			}
		}
	}

	onunload() {
		console.log("Unloading Update Modified Time plugin");
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class UpdateModifiedTimeSettingTab extends PluginSettingTab {
	plugin: UpdateModifiedTimePlugin;

	constructor(app: App, plugin: UpdateModifiedTimePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("Debug Mode")
			.setDesc("Enable debug mode to display detailed logs")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.debug)
					.onChange(async (value) => {
						this.plugin.settings.debug = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Automatic Update")
			.setDesc("Automatically update modified time on file change")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoUpdate)
					.onChange(async (value) => {
						this.plugin.settings.autoUpdate = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
