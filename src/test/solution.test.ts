import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { conventionalParent, parseProject, parseSln, parseSlnx } from '../solution/parse';
import { SolutionModel, solutionRootKey } from '../solution/solutionModel';
import { FileModel } from '../ui/fileModel';

const SLN = `
Microsoft Visual Studio Solution File, Format Version 12.00
# Visual Studio Version 17
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "src\\App\\App.csproj", "{11111111-1111-1111-1111-111111111111}"
EndProject
Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "src", "src", "{22222222-2222-2222-2222-222222222222}"
EndProject
Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "Solution Items", "Solution Items", "{33333333-3333-3333-3333-333333333333}"
	ProjectSection(SolutionItems) = preProject
		.editorconfig = .editorconfig
		README.md = README.md
	EndProjectSection
EndProject
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Legacy", "Legacy\\Legacy.csproj", "{44444444-4444-4444-4444-444444444444}"
EndProject
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Site", "Site", "{66666666-6666-6666-6666-666666666666}"
EndProject
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Gone", "Gone\\Gone.csproj", "{55555555-5555-5555-5555-555555555555}"
EndProject
Global
	GlobalSection(NestedProjects) = preSolution
		{11111111-1111-1111-1111-111111111111} = {22222222-2222-2222-2222-222222222222}
	EndGlobalSection
EndGlobal
`;

const SDK_PROJECT = `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Serilog" Version="3.1.1" />
    <ProjectReference Include="..\\Lib\\Lib.csproj" />
    <!-- <PackageReference Include="Commented.Out" /> -->
  </ItemGroup>
  <ItemGroup>
    <Compile Remove="Generated\\**" />
    <None Remove="Generated\\**" />
    <Compile Include="..\\Shared\\Shared.cs" Link="Shared\\Shared.cs" />
  </ItemGroup>
</Project>`;

const LEGACY_PROJECT = `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <TargetFrameworkVersion>v4.8</TargetFrameworkVersion>
  </PropertyGroup>
  <ItemGroup>
    <Reference Include="System" />
    <Reference Include="Newtonsoft.Json, Version=13.0.0.0, Culture=neutral">
      <HintPath>..\\packages\\Newtonsoft.Json.dll</HintPath>
    </Reference>
  </ItemGroup>
  <ItemGroup>
    <Compile Include="Form1.cs">
      <SubType>Form</SubType>
    </Compile>
    <Compile Include="Form1.Designer.cs">
      <DependentUpon>Form1.cs</DependentUpon>
    </Compile>
    <Compile Include="Properties\\AssemblyInfo.cs" />
    <Compile Include="My%20File.cs" />
    <None Include="App.config" />
  </ItemGroup>
</Project>`;

suite('solution parsing', () => {
	test('.sln: projects, solution folders, nesting and solution items', () => {
		const { entries } = parseSln(SLN);
		const app = entries.find(e => e.name === 'App')!;
		assert.strictEqual(app.kind, 'project');
		assert.strictEqual(app.path, 'src/App/App.csproj');
		assert.strictEqual(app.parent, '22222222-2222-2222-2222-222222222222');
		const items = entries.find(e => e.name === 'Solution Items')!;
		assert.strictEqual(items.kind, 'folder');
		assert.deepStrictEqual(items.files, ['.editorconfig', 'README.md']);
	});

	test('.slnx: folders by path, top-level projects and files', () => {
		const { entries } = parseSlnx(`<Solution>
  <Folder Name="/Solution Items/">
    <File Path="Directory.Build.props" />
  </Folder>
  <Folder Name="/src/libs/">
    <Project Path="src/Lib/Lib.csproj" />
  </Folder>
  <Project Path="App/App.csproj" />
</Solution>`);
		const lib = entries.find(e => e.name === 'Lib')!;
		const libs = entries.find(e => e.id === lib.parent)!;
		assert.strictEqual(libs.name, 'libs');
		assert.strictEqual(entries.find(e => e.id === libs.parent)?.name, 'src', 'parent folders are created');
		assert.strictEqual(entries.find(e => e.name === 'App')?.parent, undefined);
		assert.deepStrictEqual(entries.find(e => e.name === 'Solution Items')?.files, ['Directory.Build.props']);
	});

	test('SDK-style project: references, removes and linked files', () => {
		const p = parseProject(SDK_PROJECT);
		assert.strictEqual(p.sdk, 'Microsoft.NET.Sdk.Web');
		assert.deepStrictEqual(p.targetFrameworks, ['net8.0']);
		assert.deepStrictEqual(p.packages, [{ name: 'Serilog', version: '3.1.1' }]);
		assert.deepStrictEqual(p.projects, ['../Lib/Lib.csproj']);
		assert.deepStrictEqual(p.removes.map(r => r.pattern), ['Generated/**', 'Generated/**']);
		assert.deepStrictEqual(p.items, [{ type: 'Compile', path: '../Shared/Shared.cs', link: 'Shared/Shared.cs', dependentUpon: undefined }]);
	});

	test('old-style project: items, DependentUpon, escaped names, references', () => {
		const p = parseProject(LEGACY_PROJECT);
		assert.strictEqual(p.sdk, undefined);
		assert.deepStrictEqual(p.assemblies.map(a => a.name), ['System', 'Newtonsoft.Json']);
		assert.deepStrictEqual(
			p.items.map(i => i.path),
			['Form1.cs', 'Form1.Designer.cs', 'Properties/AssemblyInfo.cs', 'My File.cs', 'App.config'],
		);
		assert.strictEqual(p.items[1].dependentUpon, 'Form1.cs');
	});

	test('Visual Studio file nesting conventions', () => {
		const siblings = new Set(['appsettings.json', 'appsettings.development.json', 'index.cshtml', 'index.cshtml.cs', 'site.css', 'site.min.css', 'program.cs']);
		assert.strictEqual(conventionalParent('appsettings.Development.json', siblings), 'appsettings.json');
		assert.strictEqual(conventionalParent('Index.cshtml.cs', siblings), 'index.cshtml');
		assert.strictEqual(conventionalParent('site.min.css', siblings), 'site.css');
		assert.strictEqual(conventionalParent('Program.cs', siblings), undefined);
		assert.strictEqual(conventionalParent('appsettings.json', siblings), undefined);
	});
});

suite('solution model', () => {
	test('builds the Solution Explorer tree from disk', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-sln-'));
		const write = (rel: string, text = '') => {
			fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
			fs.writeFileSync(path.join(dir, rel), text);
		};
		write('Test.sln', SLN);
		write('.editorconfig');
		write('README.md');
		write('src/App/App.csproj', SDK_PROJECT);
		write('src/App/Program.cs');
		write('src/App/appsettings.json');
		write('src/App/appsettings.Development.json');
		write('src/App/bin/Debug/App.dll');
		write('src/App/obj/project.assets.json');
		write('src/App/Generated/Gen.cs');
		write('src/App/Properties/launchSettings.json');
		write('src/Shared/Shared.cs');
		// Saved as UTF-16 with a byte order mark, as Visual Studio sometimes does.
		fs.mkdirSync(path.join(dir, 'Legacy'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'Legacy/Legacy.csproj'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(LEGACY_PROJECT, 'utf16le')]));
		write('Site/index.html');
		write('Legacy/Form1.cs');
		write('Legacy/Form1.Designer.cs');
		write('Legacy/NotInProject.cs');

		const files = new FileModel();
		const model = new SolutionModel(files);
		try {
			const sln = vscode.Uri.file(path.join(dir, 'Test.sln'));
			model.track([{ sln, folder: vscode.Uri.file(dir) }]);
			const rootKey = solutionRootKey(sln);
			const names = async (key: string) => (await model.list(rootKey, key)).map(r => r.name + (r.desc ? ' ' + r.desc : ''));
			const byName = async (key: string, name: string) => (await model.list(rootKey, key)).find(r => r.name === name)!;

			assert.deepStrictEqual(await names(rootKey), ["Solution 'Test' (3 of 4 projects)"]);
			const top = rootKey + ':s';
			assert.deepStrictEqual(await names(top), ['Solution Items', 'src', 'Gone (unavailable)', 'Legacy', 'Site']);
			assert.match((await byName(top, 'Gone')).tip ?? '', /file not found/, 'the reason is in the tooltip');
			assert.deepStrictEqual(await names((await byName(top, 'Site')).key), ['index.html'], 'folder project without a trailing slash');
			assert.deepStrictEqual(await names((await byName(top, 'Solution Items')).key), ['.editorconfig', 'README.md']);

			const app = await byName((await byName(top, 'src')).key, 'App');
			assert.deepStrictEqual(
				await names(app.key),
				['Dependencies', 'Properties', 'Shared', 'appsettings.json', 'Program.cs'],
				'bin, obj, removed folders and nested files are hidden; Properties comes first',
			);
			const deps = await byName(app.key, 'Dependencies');
			assert.deepStrictEqual(await names(deps.key), ['Frameworks', 'Packages', 'Projects']);
			assert.deepStrictEqual(await names((await byName(deps.key, 'Frameworks')).key), ['Microsoft.AspNetCore.App', 'Microsoft.NETCore.App']);
			assert.deepStrictEqual(await names((await byName(deps.key, 'Packages')).key), ['Serilog (3.1.1)']);
			assert.deepStrictEqual(await names((await byName(app.key, 'Shared')).key), ['Shared.cs'], 'linked file');
			const settings = await byName(app.key, 'appsettings.json');
			assert.ok(settings.nest);
			assert.deepStrictEqual(await names(settings.key), ['appsettings.Development.json']);

			const legacy = await byName(top, 'Legacy');
			assert.deepStrictEqual(
				await names(legacy.key),
				['References', 'Properties', 'App.config', 'Form1.cs', 'My File.cs'],
				'only files listed in the project',
			);
			assert.deepStrictEqual(await names((await byName(legacy.key, 'Form1.cs')).key), ['Form1.Designer.cs']);
			assert.deepStrictEqual(await names((await byName(legacy.key, 'References')).key), ['Newtonsoft.Json', 'System']);

			// Reveal: solution > src > App > appsettings.json (nested parent).
			const found = await model.revealChain(vscode.Uri.file(path.join(dir, 'src/App/appsettings.Development.json')));
			assert.ok(found);
			assert.deepStrictEqual(found.chain, [top, (await byName(top, 'src')).key, app.key, settings.key]);
			assert.strictEqual(await model.revealChain(vscode.Uri.file(path.join(dir, 'src/App/bin/Debug/App.dll'))), undefined);

			// Another workspace is on screen: a click on this one's tab asks for its tree before the
			// switch has happened, and must still get the solution, not the plain folder.
			model.track([], [{ sln, folder: vscode.Uri.file(dir) }]);
			assert.ok(model.isRoot(rootKey));
			assert.deepStrictEqual(await names(rootKey), ["Solution 'Test' (3 of 4 projects)"]);
			assert.deepStrictEqual(await names(app.key), ['Dependencies', 'Properties', 'Shared', 'appsettings.json', 'Program.cs']);
		} finally {
			model.dispose();
			files.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
