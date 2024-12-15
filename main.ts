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

declare module "obsidian" {
	interface App {
		commands: {
			executeCommandById(customCommand: string): unknown;
			listCommands(): { id: string; name: string }[];
		};
	}
}

interface FrontMatterTimestampsSettings {
	autoUpdate: boolean;
	autoAddTimestamps: boolean;
	createdPropertyName: string;
	modifiedPropertyName: string;
	dateFormat: string;
	allowNonEmptyNewFile: boolean;
	delayAddingTimestamps: number;
	excludedFolders: string[];
	customCommand: string;
	debug: boolean;
}

const DEFAULT_SETTINGS: FrontMatterTimestampsSettings = {
	autoUpdate: true,
	autoAddTimestamps: true,
	createdPropertyName: "created",
	modifiedPropertyName: "modified",
	dateFormat: "YYYY-MM-DDTHH:mm:ssZ",
	allowNonEmptyNewFile: false,
	delayAddingTimestamps: 1000,
	excludedFolders: [],
	customCommand: "",
	debug: false,
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

	private pendingNewFiles = new Set<string>();

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

		// Listen for new file creations
		this.registerEvent(
			this.app.vault.on("create", (file: TFile) => {
				if (this.settings.debug) {
					console.log(`File created: ${file.path}`);
				}
				// Mark this file as newly created so we can process it after a delay
				if (
					this.settings.autoAddTimestamps &&
					file.extension === "md" &&
					!this.isPathExcluded(file.path)
				) {
					this.pendingNewFiles.add(file.path);
					this.handleNewFileTimestamps(file);
				}
			})
		);

		// Listen for active leaf changes if autoUpdate is enabled
		if (this.settings.autoUpdate) {
			this.registerEvent(
				this.app.workspace.on("active-leaf-change", () =>
					this.handleFileChange()
				)
			);
		}
	}

	private async handleNewFileTimestamps(file: TFile) {
		const { debug } = this.settings;

		// If not allowed to treat non-empty new files as new, check content
		if (!this.settings.allowNonEmptyNewFile) {
			const fileContent = await this.app.vault.read(file);
			if (fileContent.trim()) {
				if (debug) {
					console.log(
						`File ${file.path} is not empty, skipping initial timestamps.`
					);
				}
				this.pendingNewFiles.delete(file.path);
				return;
			}
		}

		// Wait the configured delay to allow other plugins (e.g. Templater) to do their work
		if (debug) {
			console.log(
				`Waiting ${this.settings.delayAddingTimestamps}ms before adding timestamps to ${file.path}.`
			);
		}
		await new Promise((resolve) =>
			setTimeout(resolve, this.settings.delayAddingTimestamps)
		);

		// Check if file still exists after delay
		if (!(await this.app.vault.adapter.exists(file.path))) {
			if (debug) {
				console.log(
					`File ${file.path} no longer exists after delay, skipping timestamp addition.`
				);
			}
			this.pendingNewFiles.delete(file.path);
			return;
		}

		const currentTime = moment().format(this.settings.dateFormat);

		try {
			await this.app.fileManager.processFrontMatter(
				file,
				(frontmatter) => {
					if (!frontmatter[this.settings.createdPropertyName]) {
						frontmatter[this.settings.createdPropertyName] =
							currentTime;
					}
					if (!frontmatter[this.settings.modifiedPropertyName]) {
						frontmatter[this.settings.modifiedPropertyName] =
							currentTime;
					}
				}
			);
			if (debug) {
				console.log(`Timestamps added to new file ${file.path}`);
			}
		} catch (error) {
			console.error(
				`Error adding timestamps to new file ${file.path}`,
				error
			);
		} finally {
			this.pendingNewFiles.delete(file.path);
		}
	}

	async handleFileChange() {
		const { debug } = this.settings;
		const markdownView =
			this.app.workspace.getActiveViewOfType(MarkdownView);
		const currentFile = markdownView ? markdownView.file : null;

		if (debug) {
			console.log("handleFileChange called");
		}

		// If no active file, check the previously active file for modifications
		if (!currentFile) {
			if (
				this.lastActiveFile &&
				!this.isPathExcluded(this.lastActiveFile.path)
			) {
				try {
					// Check if the last active file still exists
					const fileExists = await this.app.vault.adapter.exists(
						this.lastActiveFile.path
					);
					if (fileExists) {
						const currentChecksum = await calculateChecksum(
							this.lastActiveFile,
							this.app.vault
						);
						if (this.lastChecksum !== currentChecksum) {
							if (debug) {
								console.log(
									`File ${this.lastActiveFile.path} changed while inactive, updating modified time.`
								);
							}
							await this.updateModifiedTime(this.lastActiveFile);
						}
					} else if (debug) {
						console.log(
							`Last active file ${this.lastActiveFile.path} no longer exists.`
						);
					}
				} catch (error) {
					console.error(
						`Error checking checksum for ${this.lastActiveFile.path}:`,
						error
					);
				}
			}
			this.lastActiveFile = null;
			this.lastChecksum = null;
			return;
		}

		if (this.isPathExcluded(currentFile.path)) return;

		// Check if switching away from another file
		if (
			this.lastActiveFile &&
			this.lastActiveFile.path !== currentFile.path
		) {
			try {
				const lastFileExists = await this.app.vault.adapter.exists(
					this.lastActiveFile.path
				);
				if (lastFileExists) {
					const lastFileChecksum = await calculateChecksum(
						this.lastActiveFile,
						this.app.vault
					);
					if (this.lastChecksum !== lastFileChecksum) {
						if (debug) {
							console.log(
								`File ${this.lastActiveFile.path} changed before switching, updating modified time.`
							);
						}
						await this.updateModifiedTime(this.lastActiveFile);
					}
				}
			} catch (error) {
				console.error(
					`Error checking checksum for ${this.lastActiveFile.path}:`,
					error
				);
			}
		}

		// Update the last active file and checksum if the current file has changed
		if (
			!this.lastActiveFile ||
			this.lastActiveFile.path !== currentFile.path
		) {
			this.lastActiveFile = currentFile;
			this.lastChecksum = await calculateChecksum(
				currentFile,
				this.app.vault
			);
		}
	}

	async updateModifiedTime(file: TFile | null) {
		const { debug } = this.settings;
		if (!file || !file.path) return;
		if (this.isPathExcluded(file.path)) return;

		if (file.extension !== "md") {
			if (debug) {
				console.log("File is not a markdown file, skipping.");
			}
			return;
		}

		const currentTime = moment().format(this.settings.dateFormat);

		if (debug) {
			console.log(
				`Updating modified time for ${file.path} after a delay of ${this.settings.delayAddingTimestamps}ms.`
			);
		}

		await new Promise((resolve) =>
			setTimeout(resolve, this.settings.delayAddingTimestamps)
		);

		// Check if file still exists after delay
		if (!(await this.app.vault.adapter.exists(file.path))) {
			if (debug) {
				console.log(
					`File ${file.path} no longer exists after delay, skipping modified time update.`
				);
			}
			return;
		}

		try {
			await this.app.fileManager.processFrontMatter(
				file,
				(frontmatter) => {
					frontmatter[this.settings.modifiedPropertyName] =
						currentTime;
				}
			);

			if (debug) {
				console.log(`File frontmatter updated for ${file.path}`);
			}

			if (this.settings.customCommand) {
				this.app.commands.executeCommandById(
					this.settings.customCommand
				);
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
			.setName("Date and time format")
			.setDesc(
				"Specify the desired date and time format using Moment.js tokens. Example: YYYY-MM-DDTHH:mm"
			)
			.addText((text) => {
				text.setPlaceholder("YYYY-MM-DDTHH:mm:ssZ")
					.setValue(this.plugin.settings.dateFormat)
					.onChange(async (value) => {
						this.plugin.settings.dateFormat =
							value.trim() || DEFAULT_SETTINGS.dateFormat;
						await this.plugin.saveSettings();
					});

				const resetButton = text.inputEl.parentElement!.createEl(
					"button",
					{
						text: "Reset",
						cls: "mod-ghost",
					}
				);

				resetButton.addEventListener("click", async () => {
					text.setValue(DEFAULT_SETTINGS.dateFormat);

					this.plugin.settings.dateFormat =
						DEFAULT_SETTINGS.dateFormat;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Allow non-empty file to be treated as new note")
			.setDesc(
				"Newly created file does not have to be empty to add timestamps. Enable if using plugins that automatically add content to new notes (Templater, Daily Notes, etc.)."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.allowNonEmptyNewFile)
					.onChange(async (value) => {
						this.plugin.settings.allowNonEmptyNewFile = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Delay adding timestamps to new notes")
			.setDesc(
				"Delay in milliseconds before adding timestamps to new notes to avoid conflicts with other plugins that also add content to new notes. The default value of 1000 milliseconds should be sufficient for most cases, but you can adjust it as needed. Set to 0 to disable the delay if you are not experiencing any issues or not using such plugins."
			)
			.addText((text) =>
				text
					.setValue(
						this.plugin.settings.delayAddingTimestamps.toString()
					)
					.onChange(async (value) => {
						const delay = parseInt(value.trim(), 10);
						if (!isNaN(delay)) {
							this.plugin.settings.delayAddingTimestamps = delay;
							await this.plugin.saveSettings();
						}
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
					const trimmedValue = addInput.value
						.trim()
						.replace(/\/+$/, "");
					this.plugin.settings.excludedFolders.push(trimmedValue);
					await this.plugin.saveSettings();
					addInput.value = "";
					updateFolderList();
					event.preventDefault();
				}
			});

			const addButton = addButtonDiv.createEl("button", { text: "Add" });
			addButton.onclick = async () => {
				if (addInput.value.trim().length > 0) {
					const trimmedValue = addInput.value
						.trim()
						.replace(/\/+$/, "");
					this.plugin.settings.excludedFolders.push(trimmedValue);
					await this.plugin.saveSettings();
					addInput.value = "";
					updateFolderList();
				}
			};
		};

		updateFolderList();

		const commandSetting = new Setting(containerEl)
			.setName("Execute command after update")
			.setDesc(
				"Select a command to run after the modified time is successfully updated"
			);

		const select = commandSetting.controlEl.createEl("select");

		let noneOption = select.createEl("option", { text: "None" });
		noneOption.value = "";
		if (this.plugin.settings.customCommand === "") {
			noneOption.selected = true;
		}

		this.app.commands
			.listCommands()
			.forEach((command: { name: any; id: string }) => {
				let option = select.createEl("option", { text: command.name });
				option.value = command.id;
				if (command.id === this.plugin.settings.customCommand) {
					option.selected = true;
				}
			});

		select.addEventListener("change", async () => {
			this.plugin.settings.customCommand = select.value;
			await this.plugin.saveSettings();
		});

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
