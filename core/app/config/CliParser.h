#pragma once

#include <algorithm>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace resostage {

struct CliOption {
    std::string shortOpt;
    std::string longOpt;
    std::string description;
    std::string defaultValue;
    bool isFlag = false;
};

class CliParser {
public:
    CliParser(std::string appName, std::string appDesc)
        : name(std::move(appName)), desc(std::move(appDesc)) {}

    void addOption(const std::string& shortOpt,
                   const std::string& longOpt,
                   const std::string& description,
                   const std::string& defaultValue = "",
                   bool isFlag = false) {
        options.push_back({shortOpt, longOpt, description, defaultValue, isFlag});
    }

    std::string generateHelp() const {
        std::ostringstream ss;
        ss << name << "\n" << desc << "\n\nUsage: " << name << " [options] [project_file]\n\nOptions:\n";
        for (const auto& opt : options) {
            std::string label = "  ";
            if (!opt.shortOpt.empty()) {
                label += "-" + opt.shortOpt + ", ";
            } else {
                label += "    ";
            }
            label += "--" + opt.longOpt;
            if (!opt.isFlag && !opt.defaultValue.empty()) {
                label += "=<val>";
            }
            while (label.length() < 30) {
                label += " ";
            }
            ss << label << opt.description;
            if (!opt.defaultValue.empty()) {
                ss << " (default: " << opt.defaultValue << ")";
            }
            ss << "\n";
        }
        return ss.str();
    }

private:
    std::string name;
    std::string desc;
    std::vector<CliOption> options;
};

} // namespace resostage
