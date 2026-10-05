# PCGen Revamp

A fork of [PCGen](https://github.com/PCGen/pcgen) with a modern front end for **Pathfinder 1e** character building. The rules engine and the data books are PCGen's, untouched; the old Swing interface is replaced by a browser-style app that is fast to use, easy to read, and explains the rules in plain words.

> This is an independent fork and is not affiliated with the PCGen project. It is not meant to be merged back upstream. The original PCGen README follows [further down](#about-pcgen-upstream-readme).

## Why

PCGen holds more than twenty years of carefully written rules data, and its engine is the part that is hard to get right. The interface is the part that has aged: dense dialogs, jargon straight from the data files, and a long start-up. The idea of this project is to keep everything that is valuable and replace only what players touch.

- **Keep the engine and the data.** No rewrite of the rules engine or the LST data format. Every number on the sheet still comes from PCGen.
- **Make it fast once it is running.** Loading the rules data takes seconds, so it is done once at start-up and then kept in memory. After that, reads take milliseconds and most changes well under a second.
- **Say what the rules say, in plain words.** When something cannot be taken, the app names the requirement it fails ("must be a Half Orc; needs Inquisitor") instead of "requirements not met". PCGen's internal type tags are tucked away in a "Technical details" fold-out.
- **Slow is fine, failing is not.** Nothing the engine is doing is ever cut off by a timeout.
- **Test against the real engine,** not against mocks.

## What it looks like in use

Open a character and work in tabs: **Overview** (ability scores, levels, hit points, experience, identity, what is still to do), **Class**, **Feats**, **Skills**, **Spells**, **Gear**, **Biography** (appearance, languages, notes, race and background) and **Sheet** (a live PDF character sheet). Sections fold; clicking a feat, class feature, trait or spell opens its full description in a side panel; the "Add" pickers show what an entry does before you take it, and filter themselves to what your character can actually take (spell levels your class can cast, favored class bonuses you qualify for). When PCGen needs a decision from you, such as which ability score to raise at level 4, it appears as a dialog.

## How it works

```
browser (React app, revamp/ui)
   |  /api  (Vite dev server proxies to the sidecar)
   v
sidecar (Java HTTP server, revamp/sidecar, 127.0.0.1 only)
   |  calls PCGen's own "facade" layer, the same one its Swing UI uses
   v
PCGen engine (unchanged) + the rules data
```

- **One process per rule set.** PCGen can hold one data set per Java process and keeps global state, so the sidecar loads one game mode and source-book set at start-up and runs every engine call on a single worker thread. The character you open decides which books are loaded.
- **The engine asks questions mid-operation.** Choosers ("pick a school for Spell Focus"), yes/no confirmations and the custom-item builder block inside PCGen until someone answers. The sidecar parks the operation and replies **HTTP 202** with the question; the answer call resumes it and returns the final result. The UI turns these into dialogs.
- **Descriptions come from PCGen itself.** The engine's own info text is parsed into labelled sections, and the unmet part of a requirement is read from its red markup.
- **PDF sheets** use PCGen's own FOP pipeline; a throwaway PDF is rendered after start-up to warm it.
- **The API is local only.** The server binds to the loopback address and refuses requests with a foreign `Host` or `Origin` header, so a web page you visit cannot drive it. Templates and saves are confined to the output-sheets folder and `.pcg` files.
- **Tests run the real engine:** command-line export snapshots, a sidecar per sample character, every API route group with latency budgets, and a browser test that drives the UI in Edge.

## Changes to PCGen's own files

Everything new lives in [`revamp/`](revamp/). Changes to PCGen proper are deliberate and kept as separate small commits:

1. Variable channels and wrappers are cached per character. Before this, **funds were shared by every open character** in a session.
2. The Half-Orc race now applies its identifying template, so half-orc favored class bonuses (which require `IsHalfOrc`) can be taken. They never could.

## Status

Working: the tabs above, level-ups with a hit point roll dialog, feats and class choices, skills, spells (known lists and per-class level limits), gear and the custom item builder, languages, notes, PDF export. Not built yet: spell preparation and spell books in the UI, equipment sets, companions and familiars, kits and temporary bonuses, a new-character wizard, a source-book picker and launcher, and packaging as a desktop app. [`revamp/PROGRESS.md`](revamp/PROGRESS.md) has the full list and the order planned.

## Run it

You need JDK 25, Node 22 or newer, Python 3 and Microsoft Edge (for the browser test) on Windows.

```powershell
# once: build the engine (about 1.5 minutes) and the sidecar
$env:JAVA_HOME = 'C:\path\to\jdk-25'      # wherever your JDK 25 is
.\gradlew qbuild -x test
.\revamp\sidecar\build.ps1
cd revamp\ui; npm install; cd ..\..

# start the engine and the UI on a copy of one of your characters
.\revamp\start-dev.ps1 -Character path\to\your.pcg      # opens http://127.0.0.1:5173
.\revamp\stop-dev.ps1
```

The script works on a **copy** of the character, so nothing is saved to your file unless you copy it back. More in [`revamp/README.md`](revamp/README.md) and [`CLAUDE.md`](CLAUDE.md) (commands, tests, gotchas).

## License

PCGen is licensed under the LGPL; this fork keeps that license ([LICENSE](LICENSE)).

---

# About PCGen (upstream README)

![PCGenShot](https://user-images.githubusercontent.com/470400/67638917-5f6e8a80-f8c0-11e9-972b-7adf4c9126e7.png)

PCGen is a program designed to create and manage player characters in pen & paper games like D&D.
It works on Windows, Mac & Linux, basically anywhere the Java JDK works.
It will let you create a character under a system of rules, track its levels and abilities as you progress, inventory and spells.
It supports numerous game systems, most notably:

- D&D 3.5, 4.0, 5.0
- Pathfinder 1e
- Starfinder

# Table of Contents
1. [Installing PCGen](#installing-pcgen)

2. [PCGen Needs You](#pcgen-needs-you)

3. [The Old Wiki](#the-old-wiki)

4. [PCGen LST Tutorial](#pcgen-lst-tutorial)

5. [Basic Workflow](#basic-workflow)

6. [Development Setup](#development-setup)

7. [Essential Gradle Tasks](#essential-gradle-tasks)

# Installing PCGen
> Note: Java does not need to be preinstalled with PcGen >6.09.05

## Using Zip bundle
1. Download and extract the full zip file from https://github.com/PCGen/pcgen/releases/ labeled 6.09.xx.

2. You should now be able to run PCGen. The exact invocation depends on your operating system, but you should be able to either double-click to launch the file for your platform.
    - Windows: `pcgen.exe` (`pcgen.bat` for command-line users)
    - Linux: `pcgen.sh`
    - Mac: `pcgen.sh` (or `pcgen.dmg` if it exists. Launching .jar may throw java errors so generally avoid)

## Using installer (windows and mac only)
1. Download and extract the full installer from https://github.com/PCGen/pcgen/releases/ labeled 6.09.xx. 
    - Windows: `pcgen-6.09.xx_win_install.exe`
    - Mac: `pcgen-6.09.xx.dmg` or `pcgen-6.09.xx.pkg`

2. Run installer and follow instruction
   - Windows: Open `pcgen-6.09.xx_win_install.exe`
   - Mac:
   - - `dmg`: Open `dmg` and drag into Applications. Right-click on `PcGen` and click open.
   - - `pkg`: Right-click and `pkg` and click open and click `open` on security warning due to application being unsigned. 

3. You should be able to launch PcGen as a normal application.
   -  Mac: You may need to on first launch right-click on application and then click `open`.

# PCGen Needs You

PCGen is an open-source program driven by contributors; without your help, no new fixes or content can be added.
If you can program Java or want to contribute to expanding the book support, please consider joining our team.
Many of the original members have become inactive, and we need new contributors to keep the project going.

To join our group:
- Join our [Discord](https://discord.gg/M7GH5BS)
- Post in the volunteer channel to get access to the [Slack](https://slack.com). A senior member will add you by email.
- Make an account on the [JIRA] bug tracker. See [CODE] and [DATA] issues. Work is tracked here to easily generate release notes.
- Review the [Basic Workflow](#basic-workflow) & [Development Setup](#development-setup) below to get started.

# The Old Wiki
The [old wiki](http://159.203.101.162/w/index.php) archives historical meetings, many design documents and useful dev information.
Browse it when you have time, it can provide some insight into certain parts of the architecture.

# PCGen LST Tutorial
Andrew has made a series of videos [explaining the LST files](https://www.youtube.com/watch?v=LhGkqdXNtOw&list=PLLa5A1qjBOPekqEC_R9BAZW-8q5IT-klM).
These are mainly targeted at new DATA contributors adding new books/content and fixing bugs.
You can, of course, ask questions in the discord or Slack if you are unsure.
Programmers may want to review these if they work on the LST parsing or related systems.

# Basic Workflow

1. Get a bug from [JIRA] primarily from the [CODE] or [DATA] sections. Alternatively, if you want to propose a new feature/change, make a JIRA entry to track it.
2. Create a branch in your fork of [PCGen] during development. It is good to name branches after ticket numbers, like fix_code_3444 or fix_data_3322.
3. Work until the feature or bug is finished. Add tests if needed, especially if new code is added.
4. Push all work up into your copy of [PCGen]. Try to ensure the build passes BEFORE submitting a pull request.
5. Submit a pull request from your fork to master and respond to a review by members.
6. Go back to the first step.

# Development Setup

These steps will guide you to a basic setup for development.
These steps should work for Linux, Mac or Windows. Where steps differ, it will be highlighted.
If you have trouble, feel free to ask in the Discord or Slack once you have joined.

### Running Commands
Anything `written like this` should be executed in a terminal.
For Windows this means opening the start menu and typing cmd.exe or PowerShell. The latter is more modern if available.
For Linux or Mac, whatever default terminal you have is fine.

### Install Java
Check the installed version with:

    java -version

For development you will want Java with a minimum version of 25.
You can install the latest version from [Eclipse Temurin](https://adoptium.net) regardless of your OS, please see instructions there.

### Install Git
Check the installed version with:

    git --version

Any version should do.
You can install git on debian machines:

    sudo apt-get install git

On Windows, [Git For Windows](https://gitforwindows.org) is a good choice. Download and install.
Be sure to install both the GUI & command line version. The default options are fine.

If you do not know about git, reading the first three or four chapters of [Pro Git](https://git-scm.com/book/en/v2)
will go a long way. It is designed about command line, but all principles apply to the GUI version.

### Fork and Clone PCGen
Log in to GitHub and go to [PCGen] in your browser.
Fork the project to have your own copy.
Clone the fork locally, if you use ssh for instance, it should be:

    git clone git@github.com:USERNAME/pcgen.git

Where USERNAME is your GitHub username.
This can be done on the command line, or else open the git GUI and clone from there.

### Stay Up To Date
Open a terminal inside the cloned pcgen project.
Run the following command:

    git remote add upstream https://github.com/PCGen/pcgen

This sets up the project for upstream rebasing to keep you level with changes.
You can rebase the master with the latest changes with the following. It can be done from GUI as well.

    git fetch upstream && git checkout master && git rebase upstream/master

### Get an IDE
This step is optional. You are free to program in what you prefer, these are several popular IDEs for Java.
If you are new, we would suggest IntelliJ. Follow download/setup instructions, then continue.
These IDEs have git and gradle plugins either out of the box or that can be installed.
- [IntelliJ Community](https://www.jetbrains.com/idea)
- [Eclipse](https://www.eclipse.org)
- [Netbeans](https://netbeans.org)

Once setup, open your IDE of choice. You should be able to import the cloned fork.
Import the [PCGen] fork as a Gradle project. From this point, you can work on the project.
For IntelliJ Community do: File > New > Project from Existing Sources ...
All of these IDEs have git and gradle plugins that can be used instead of commands.

# Essential Gradle Tasks

This is a __quick__ rundown on Gradle. You can get more information from [gradle docs](https://gradle.org/guides).
Gradle is like make, it allows you to run commands to build projects.
The tasks can depend on one another and will ensure all dependencies are met before running.
These commands will be the same if you use a GUI to execute them.

Note: `./gradlew` indicates you are executing the Gradle wrapper command binary that comes with PCGen's source tree.
This will automatically download and use the latest version of Gradle. If you have Gradle installed, you just
substitute `./gradlew` for `gradle` on the command line.

### See All Available Commands
    ./gradlew tasks

### (Re)Compile Java
    ./gradlew compileJava

### Build All Required Files
    ./gradlew assemble

### Run PCGen
    ./gradlew run

### Run Test Suite
    ./gradlew test

### Run Full Test Suite
Do this primarily __before__ pull requests.
This mirrors what GitHub Actions runs to verify a PR; if it fails locally your CI build will also fail and your PR will not be merged.

    ./gradlew build
    ./gradlew itest datatest slowtest

`build` already runs the unit `test` task via the standard Java lifecycle, so it is not repeated. The second command runs the integration, data, and slow test suites.

### Clean All Build Files
    ./gradlew clean

### Generate IntelliJ IDEA Project
    ./gradlew idea

### Build Native Application Bundle (jpackage)
Produces a self-contained native app with a bundled JVM for the current platform.
**Always use `fullJpackage`** — not `jpackageImage` directly. `jpackageImage` only builds
the JVM runtime; `fullJpackage` also copies the required `data`, `plugins`, `preview`, and
`outputsheets` folders into the bundle.

    ./gradlew fullJpackage

The output is placed in `build/jpackage/`.

> **macOS note:** If the build fails with `Unable to delete directory 'build/jpackage'` due
> to a `.DS_Store` file, run `rm -f build/jpackage/.DS_Store` and retry.

## Bumping Java / JavaFX versions

Both versions live in `gradle.properties`:

- `javaVersion` — JDK major (drives the Gradle toolchain).
- `javafxVersion` — full JavaFX patch triple (e.g. `25.0.3`). The major **must** match `javaVersion`.

### Patch bump (e.g. 25.0.3 → 25.0.4)

JavaFX-only — Gradle's toolchain auto-resolves the latest matching JDK patch.

1. Find the latest JavaFX 25 patch on https://gluonhq.com/products/javafx/ or https://github.com/openjdk/jfx/tags.
2. Update `javafxVersion` in `gradle.properties`.
3. Verify: `./gradlew clean downloadJfxMods extractJfxMods downloadJavaFXLocal extractJavaFXLocal test`.

### Major bump (e.g. 25 → 26)

Coordinated change. Both versions move together.

1. Confirm a Temurin GA build of the new JDK exists: https://adoptium.net/temurin/releases/.
2. Find the latest JavaFX patch with the matching major (links above).
3. Update `javaVersion` **and** `javafxVersion` in `gradle.properties`.
4. Re-run the full build incl. `jlink`/`jpackage` to catch module-path drift:
   `./gradlew clean build slowtest jlink fullJpackage`.
5. Check whether any JVM flags in `build.gradle` (e.g. `--add-exports`, `--add-opens`,
   `-Dprism.order=sw`) can be dropped — JavaFX major bumps occasionally make these obsolete.

### Querying the latest JDK patch from the command line

The project used to call this Adoptium endpoint at configuration time; it's kept here as
a reference for humans and agents:

```
curl -s 'https://api.adoptium.net/v3/assets/feature_releases/25/ga?architecture=x64&page=0&page_size=1&project=jdk&sort_order=DESC&vendor=eclipse' \
  | jq -r '.[0].version_data | "\(.major).\(.minor).\(.security)"'
```

## Troubleshooting
####
If you have an error stating `Task :run FAILED Error: --module-path requires module path specification` in Intellij,
create a run configuration using Gradle and have the command be `run`. This should fix this error.

If you want to debug in Intellij, using the `Main` configuration and run it in debug mode.
You can change the Java version to whatever version is supported, and you have installed.

#### JavaFX / graphics toolkit fails to start on Linux

If PCGen exits at startup with an error `UnsatisfiedLinkError: no glassgtk3 in java.library.path`, it means that JavaFX
cannot find the linked file `libgthread-2.0.so.0`. To solve it, the missing package must be installed:

- **openSUSE Tumbleweed:** `sudo zypper install libgthread-2_0-0`
- **Other distributions:** install the glib package that provides `libgthread-2.0.so.0` (the exact package name varies).

If instead the error is `Unable to open DISPLAY`, run PCGen from a graphical desktop session rather than a remote/SSH shell.


[PCGen]: https://github.com/PCGen/pcgen
[JIRA]: https://pcgenorg.atlassian.net
[CODE]: https://pcgenorg.atlassian.net/projects/CODE/issues
[DATA]: https://pcgenorg.atlassian.net/projects/DATA/issues
