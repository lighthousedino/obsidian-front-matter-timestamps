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
}

const DEFAULT_SETTINGS: UpdateModifiedTimeSettings = {
	debug: false,
};

export default class UpdateModifiedTimePlugin extends Plugin {
	settings: UpdateModifiedTimeSettings;

	async onload() {
		console.log("Loading Update Modified Time plugin");
		await this.loadSettings();

		// Add a command to manually update the modified time
		this.addCommand({
			id: "update-modified-time",
			name: "Update Modified Time",
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

		// Add settings tab
		this.addSettingTab(new UpdateModifiedTimeSettingTab(this.app, this));
	}

	async updateModifiedTime(file: TFile) {
		if (this.settings.debug)
			console.log(`Updating modified time for file: ${file.path}`);

		if (file.extension !== "md") {
			if (this.settings.debug)
				console.log("File is not a markdown file, skipping.");
			return;
		}

		try {
			const fileContent = await this.app.vault.read(file);
			if (this.settings.debug)
				console.log("File content read successfully");
			const yamlRegex = /^---\n([\s\S]*?)\n---/;
			const match = fileContent.match(yamlRegex);
			const currentTime = moment().utc().format("YYYY-MM-DDTHH:mm:ss[Z]");

			if (!match) {
				if (this.settings.debug)
					console.log("No YAML front matter found, skipping update.");
				return;
			}

			const yamlContent = match[1];
			let newYamlContent;
			if (yamlContent.includes("modified:")) {
				if (this.settings.debug)
					console.log("Existing modified field found, updating it");
				newYamlContent = yamlContent.replace(
					/modified: .*/,
					`modified: ${currentTime}`
				);
			} else {
				if (this.settings.debug)
					console.log("No modified field found, adding it");
				newYamlContent = yamlContent + `\nmodified: ${currentTime}`;
			}

			const newFileContent = fileContent.replace(
				yamlRegex,
				`---\n${newYamlContent}\n---`
			);

			if (this.settings.debug) {
				console.log("New file content prepared");
				// console.log("Old File Content:", fileContent);
				// console.log("New File Content:", newFileContent);
			}

			await this.app.vault.modify(file, newFileContent);
			if (this.settings.debug)
				console.log("File content updated and saved");
		} catch (error) {
			if (this.settings.debug)
				console.error("Error updating file", error);
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
	}
}
