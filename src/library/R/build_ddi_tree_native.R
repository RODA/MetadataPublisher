args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 1L) {
    stop("Usage: build_ddi_tree_native.R <r-library-dir>")
}

library_dir <- normalizePath(args[[1]], mustWork = TRUE)

source(file.path(library_dir, "utils.R"))

if (!requireNamespace("DDIwR", quietly = TRUE)) {
    stop("The DDIwR package is not available in the native R environment.")
}

bundle <- list(
    tree = make_DDI_tree(),
    elements = get("DDIC", envir = DDIwR::cacheEnv)
)

cat(jsonlite::toJSON(bundle, auto_unbox = TRUE))
