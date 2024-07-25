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
	createdPropertyName: string;
	modifiedPropertyName: string;
	allowNonEmptyNewFile: boolean;
	excludedFolders: string[];
}

const DEFAULT_SETTINGS: FrontMatterTimestampsSettings = {
	debug: false,
	autoUpdate: true,
	autoAddTimestamps: true,
	createdPropertyName: "created",
	modifiedPropertyName: "modified",
	allowNonEmptyNewFile: false,
	excludedFolders: [],
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
	private isPathExcluded(filePath: string): boolean {
		// Immediate return if there are no excluded folders
		if (this.settings.excludedFolders.length === 0) {
			return false;
		}

		const pathSegments = filePath.split("/");
		// Generate all possible subpaths to compare against excluded folders
		const fullPathChecks = pathSegments.map((_, index) =>
			pathSegments.slice(0, index + 1).join("/")
		);
		return this.settings.excludedFolders.some((excludedPath) =>
			fullPathChecks.includes(excludedPath)
		);
	}

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
	}

	async handleFileChange() {
		const markdownView =
			this.app.workspace.getActiveViewOfType(MarkdownView);
		const currentFile = markdownView ? markdownView.file : null;

		if (!currentFile) {
			return; // Exit if there is no current file to process
		}

		if (!currentFile || this.isPathExcluded(currentFile.path)) return;

		const NEW_FILE_TOLERANCE = 0.3; // seconds
		const ctime = moment(currentFile.stat.ctime);
		const mtime = moment(currentFile.stat.mtime);
		const timeDifference = mtime.diff(ctime, "seconds");

		const isFileNew = timeDifference <= NEW_FILE_TOLERANCE;

		let isFileEmpty = true;
		if (!this.settings.allowNonEmptyNewFile) {
			const fileContent = await this.app.vault.read(currentFile);
			isFileEmpty = currentFile.stat.size === 0 || !fileContent.trim();
		}

		if (isFileNew && isFileEmpty && this.settings.autoAddTimestamps) {
			await this.handleFileCreate(currentFile);
		}

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
		this.lastChecksum = currentFile.path
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
					frontmatter[this.settings.createdPropertyName] =
						currentTime;
					frontmatter[this.settings.modifiedPropertyName] =
						currentTime;
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

		if (!file || !file.path || this.isPathExcluded(file.path)) return;

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
					frontmatter[this.settings.modifiedPropertyName] =
						currentTime;
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
		console.log("Unloading Front Matter Timestamps plugin");
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
			.setName("Created property name")
			.setDesc("Customise the property name for creation timestamp")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.createdPropertyName)
					.onChange(async (value) => {
						this.plugin.settings.createdPropertyName = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Modified property name")
			.setDesc("Customise the property name for modification timestamp")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.modifiedPropertyName)
					.onChange(async (value) => {
						this.plugin.settings.modifiedPropertyName =
							value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Allow non-empty file to be treated as new note")
			.setDesc(
				"Newly created file does not have to be empty to add timestamps. Enable if using plugins that automatically add content to new notes (e.g. Daily Notes with a template)."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.allowNonEmptyNewFile)
					.onChange(async (value) => {
						this.plugin.settings.allowNonEmptyNewFile = value;
						await this.plugin.saveSettings();
					})
			);

		const excludedFoldersSetting = new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc(
				"Manage folders that are excluded from timestamp updates. You can add subfolder paths as needed. For example, 'folder/subfolder' will exclude 'subfolder' but not 'folder'."
			);

		const listContainer = excludedFoldersSetting.settingEl.createDiv();

		const updateFolderList = () => {
			listContainer.empty();
			this.plugin.settings.excludedFolders.forEach((folder, index) => {
				const folderDiv = listContainer.createDiv("folder-entry");
				folderDiv.style.display = "flex";
				folderDiv.style.alignItems = "center";
				folderDiv.style.justifyContent = "space-between";
				folderDiv.style.marginBottom = "10px";

				const folderNameSpan = folderDiv.createSpan({ text: folder });
				folderNameSpan.style.flex = "1";
				folderNameSpan.style.marginRight = "20px";

				const removeButton = folderDiv.createEl("button", {
					text: "Remove",
				});
				removeButton.onclick = async () => {
					this.plugin.settings.excludedFolders.splice(index, 1);
					await this.plugin.saveSettings();
					updateFolderList();
				};
			});

			const addButtonDiv = listContainer.createDiv();
			addButtonDiv.style.display = "flex";
			addButtonDiv.style.alignItems = "center";

			const addInput = addButtonDiv.createEl("input", {
				type: "text",
				placeholder: "Add new folder path...",
			});
			addInput.style.flex = "1";
			addInput.style.marginRight = "10px";

			addInput.addEventListener("keypress", async (event) => {
				if (event.key === "Enter" && addInput.value.trim().length > 0) {
					this.plugin.settings.excludedFolders.push(
						addInput.value.trim()
					);
					await this.plugin.saveSettings();
					addInput.value = "";
					updateFolderList();
					event.preventDefault();
				}
			});

			const addButton = addButtonDiv.createEl("button", { text: "Add" });
			addButton.onclick = async () => {
				if (addInput.value.trim().length > 0) {
					this.plugin.settings.excludedFolders.push(
						addInput.value.trim()
					);
					await this.plugin.saveSettings();
					addInput.value = "";
					updateFolderList();
				}
			};
		};

		updateFolderList();

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
