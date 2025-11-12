# from the terminal, run: Rscript load_codebook_native.R <xml-path> <r-library-dir>
# from the app, the script file is spawned with these two arguments

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 2L) {
    stop("Usage: load_codebook_native.R <xml-path> <r-library-dir>")
}

xml_path <- normalizePath(args[[1]], mustWork = TRUE)
library_dir <- normalizePath(args[[2]], mustWork = TRUE)

source(file.path(library_dir, "utils.R"))

if (!requireNamespace("DDIwR", quietly = TRUE)) {
    stop("The DDIwR package is not available in the native R environment.")
}

codeBook <- DDIwR::getCodebook(xml_path)
cat(jsonlite::toJSON(normalize_codebook(codeBook), auto_unbox = TRUE))
