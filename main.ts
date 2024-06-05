import {
	App,
	Plugin,
	TFile,
	Vault,
	moment,
	MarkdownView,
	PluginSettingTab,
	Setting,
} from "obsidian";

interface FrontMatterTimestampsSettings {
	debug: boolean;
	autoUpdate: boolean;
	autoAddTimestamps: boolean;
}

const DEFAULT_SETTINGS: FrontMatterTimestampsSettings = {
	debug: false,
	autoUpdate: true,
	autoAddTimestamps: true,
};

async function calculateChecksum(file: TFile, vault: Vault): Promise<string> {
	const fileContent = await vault.read(file);
	const buffer = new TextEncoder().encode(fileContent);
	const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashHex = hashArray
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return hashHex;
}

export default class FrontMatterTimestampsPlugin extends Plugin {
	settings: FrontMatterTimestampsSettings;
	private lastActiveFile: TFile | null = null;
	private lastChecksum: string | null = null;

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new FrontMatterTimestampsSettingTab(this.app, this));

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

		// Register event to handle new file creation
		if (this.settings.autoAddTimestamps) {
			this.registerEvent(
				this.app.vault.on("create", (file) => {
					if (file instanceof TFile) {
						this.handleFileCreate(file);
					}
				})
			);
		}
	}

	async handleFileChange() {
		const markdownView =
			this.app.workspace.getActiveViewOfType(MarkdownView);
		const currentFile = markdownView ? markdownView.file : null;

		// Check if the last active file exists before calculating checksum
		if (this.lastActiveFile && this.lastActiveFile.path) {
			try {
				const currentChecksum = await calculateChecksum(
					this.lastActiveFile,
					this.app.vault
				);
				if (this.lastChecksum !== currentChecksum) {
					await this.updateModifiedTime(this.lastActiveFile);
				}
			} catch (error) {
				console.error(
					`Error checking checksum for ${this.lastActiveFile.path}:`,
					error
				);
			}
		}

		// Update the last active file and checksum
		this.lastActiveFile = currentFile;
		this.lastChecksum =
			currentFile && currentFile.path
				? await calculateChecksum(currentFile, this.app.vault)
				: null;
	}

	async handleFileCreate(file: TFile) {
		if (file.extension !== "md") {
			return;
		}

		const currentTime = moment().format("YYYY-MM-DDTHH:mm:ssZ");

		try {
			await this.app.fileManager.processFrontMatter(
				file,
				(frontmatter) => {
					if (!frontmatter.created) {
						frontmatter.created = currentTime;
					}
					frontmatter.modified = currentTime;
				}
			);

			if (this.settings.debug) {
				console.log(`Timestamps added to new file ${file.path}`);
			}
		} catch (error) {
			console.error(
				`Error adding timestamps to new file ${file.path}`,
				error
			);
		}
	}

	async updateModifiedTime(file: TFile | null) {
		if (!file || !file.path) {
			return;
		}

		try {
			if (file.extension !== "md") {
				if (this.settings.debug) {
					console.log("File is not a markdown file, skipping.");
				}
				return;
			}

			const currentTime = moment().format("YYYY-MM-DDTHH:mm:ssZ");

			await this.app.fileManager.processFrontMatter(
				file,
				(frontmatter) => {
					frontmatter.modified = currentTime;
				}
			);

			if (this.settings.debug) {
				console.log("File frontmatter updated");
			}
		} catch (error) {
			console.error(
				`Error updating frontmatter for file ${file.path}`,
				error
			);
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

class FrontMatterTimestampsSettingTab extends PluginSettingTab {
	plugin: FrontMatterTimestampsPlugin;

	constructor(app: App, plugin: FrontMatterTimestampsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("Automatic update")
			.setDesc("Automatically update modified time on file change")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoUpdate)
					.onChange(async (value) => {
						this.plugin.settings.autoUpdate = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Automatic timestamps")
			.setDesc(
				"Automatically add created and modified timestamps to new notes"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoAddTimestamps)
					.onChange(async (value) => {
						this.plugin.settings.autoAddTimestamps = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Debug mode")
			.setDesc("Enable debug mode to display detailed logs")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.debug)
					.onChange(async (value) => {
						this.plugin.settings.debug = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
